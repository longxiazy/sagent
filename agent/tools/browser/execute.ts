/**
 * 内置只读浏览器的动作执行器：导航、检查页面、提取正文/链接和滚动。
 * 成功返回文本，普通网页错误返回 failedResult；取消和会话失效向上抛出，
 * 由 browser-session-manager 负责关闭、重建和重试，避免执行器自行创建恢复循环。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { closeBrowserSession, getWebView } from './webview-session.ts';
import { isChromeMcpAvailable } from '../chrome/mcp-client.ts';
import { throwIfAborted } from '../../core/abort.ts';

// 页面渲染等待与 pending 重试是两件事；尝试次数包含首次调用。
const ACTION_SETTLE_MS = 600;
const NAV_RETRY_MS = 1000;
const EVALUATE_RETRY_MS = 500;
const NAV_MAX_ATTEMPTS = 8;
const EVALUATE_MAX_ATTEMPTS = 3;
// 首次导航与重建后的导航使用不同上限，给新实例一次更长的加载机会。
const FETCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_RETRY_MS = 25000;
const BROWSER_SESSION_INVALID_CODE = 'BROWSER_SESSION_INVALID';

// 只限制这些站点的搜索结果页，站点里的普通文章仍可访问。
const SEARCH_ENGINE_HOSTS = [
  /(^|\.)baidu\.com$/i,
  /(^|\.)google\.[^/]+$/i,
  /(^|\.)bing\.com$/i,
];

/** 页面渲染或 pending 退避期间也响应取消，停止后不再继续下一次调用。 */
function delay(ms: number, signal?: AbortSignal) {
  return sleep(ms, undefined, { signal });
}

/** 识别需要交给会话管理器处理的错误；其余网页错误可直接返回失败结果。 */
function isClosedViewError(err) {
  return err?.code === BROWSER_SESSION_INVALID_CODE
    || /view is closed|invalid state.*webview/i.test(String(err?.message || err || ''));
}

/** 给导航超时附加稳定错误码，管理器据此销毁旧实例并执行一次恢复。 */
function invalidBrowserSessionError(message) {
  const err: any = new Error(message);
  err.code = BROWSER_SESSION_INVALID_CODE;
  return err;
}

/**
 * 在原生操作、超时和取消之间取最先完成的结果，并释放本次等待的监听与定时器。
 * 超时回调关闭旧实例；取消时由 executeBrowserAction 关闭。这里不等待关闭后
 * 可能永不落定的原生 Promise，Promise.race 会接住它迟到的结果或异常。
 */
function withTimeout(promise, ms, message, onTimeout = null, invalidateSession = false, signal?: AbortSignal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(invalidateSession ? invalidBrowserSessionError(message) : new Error(message));
    }, ms);
  });
  let onAbort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal?.reason || new Error('Agent 已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  return Promise.race([promise, timeout, cancelled]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

/** http_fetch 接受省略协议的网址，默认补 https；导航动作使用调用方给定的 URL。 */
function normalizeHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
}

/** 根据主机名和搜索路径/参数拦截搜索结果页；格式错误的 URL 留给导航报告。 */
function isBlockedSearchEngineUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(normalizeHttpUrl(rawUrl));
    const hostMatches = SEARCH_ENGINE_HOSTS.some(pattern => pattern.test(parsed.hostname));
    if (!hostMatches) return false;
    const path = parsed.pathname.toLowerCase();
    return path === '/s' || path === '/search' || parsed.searchParams.has('q') || parsed.searchParams.has('wd');
  } catch {
    return false;
  }
}

/** 提示改用目标站点链接，避免模型重复打开容易触发验证码的搜索结果页。 */
function blockedSearchEngineResult(url) {
  return [
    `已阻止访问搜索引擎搜索页: ${url}`,
    'Google、百度、Bing 等搜索页容易触发反爬/验证码，且通常不是可靠的一手来源。',
    '请直接抓取目标站点 URL；如果需要多源搜索，请先筛选候选来源，再逐个使用 http_fetch。',
  ].join('\n');
}

/** 保留可读说明，同时让 runtime/trace 明确记录此动作失败，而不是当作成功文本。 */
function failedResult(result, error = result) {
  return {
    result,
    resultStatus: 'failed',
    resultError: String(error || result),
  };
}

// 导航超时会让当前 Bun.WebView 进入不可信状态。关闭并上抛会话失效，
// 由 browser-session-manager 创建新实例；禁止在同一个已关闭实例上重试。
async function navigateWithRecoveryTimeout(view, url, firstTimeoutMs, retryTimeoutMs, errMessage, recoveryAttempt = 0, signal?: AbortSignal) {
  const timeoutMs = recoveryAttempt > 0 ? retryTimeoutMs : firstTimeoutMs;
  return withTimeout(
    safeNavigate(view, url, signal),
    timeoutMs,
    `${errMessage}${recoveryAttempt > 0 ? '（恢复会话后仍超时）' : ''}`,
    () => { void closeBrowserSession(view); },
    true,
    signal,
  );
}

/**
 * Bun.WebView 前一次导航尚未结束时会报 already pending，短暂等待后再尝试。
 * 次数耗尽必须抛出最后的错误；静默返回会让调用方误报导航成功，甚至读取旧页面。
 */
export async function safeNavigate(view, url, signal?: AbortSignal) {
  for (let i = 0; i < NAV_MAX_ATTEMPTS; i++) {
    throwIfAborted(signal);
    try {
      return await view.navigate(url);
    } catch (err) {
      throwIfAborted(signal);
      if (/already pending/i.test(err.message) && i < NAV_MAX_ATTEMPTS - 1) {
        await delay(NAV_RETRY_MS, signal);
        continue;
      }
      throw err;
    }
  }
}

/** 页面求值只重试短暂的 pending 冲突；脚本错误、关闭错误和取消直接交给调用方。 */
async function safeEvaluate(view, script, signal?: AbortSignal) {
  for (let i = 0; i < EVALUATE_MAX_ATTEMPTS; i++) {
    throwIfAborted(signal);
    try {
      return await view.evaluate(script);
    } catch (err) {
      throwIfAborted(signal);
      if (/already pending/i.test(err.message) && i < EVALUATE_MAX_ATTEMPTS - 1) {
        await delay(EVALUATE_RETRY_MS, signal);
        continue;
      }
      throw err;
    }
  }
}

// 常见验证码/限流页的文本特征，用于避免把拦截提示当成抓取到的正文。
const BLOCKED_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /verify you are human/i,
  /are you a robot/i,
  /cf-browser-verification/i,
  /cloudflare.*challenge/i,
  /access denied/i,
  /403 forbidden/i,
  /blocked/i,
  /rate.?limit/i,
  /too many requests/i,
  /please.*captcha/i,
  /recaptcha/i,
  /hcaptcha/i,
  /请完成验证/i,
  /人机验证/i,
  /安全验证/i,
  /拖动.*滑块/i,
  /滑块/i,
  /请求已中断/i,
  /Web应用防护/i,
  /Web安全风险/i,
  /访问不合规/i,
];

/** 只读标题、当前 URL 和正文开头，供反爬/失效页检查使用，不执行网页交互。 */
function detectBlockedPage(view, signal?: AbortSignal) {
  return safeEvaluate(view, `(() => {
    const title = document.title || '';
    const url = window.location.href || '';
    const body = (document.body?.innerText || '').slice(0, 2000);
    return { title, url, body };
  })()`, signal);
}

/** 综合页面文本和验证路径识别拦截页；这是页面内容判断，不代表 HTTP 状态码。 */
function checkBlocked(title, url, body) {
  const text = `${title} ${url} ${body}`;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  if (/^about:/.test(url) && !body.trim()) return false;
  const blockedUrls = ['/challenge', '/captcha', '/verify', '/blocked', '/sorry'];
  for (const segment of blockedUrls) {
    if (url.toLowerCase().includes(segment)) return true;
  }
  return false;
}

/** 识别返回了 HTML 的简短 404/未找到页面，避免将错误页正文交给模型作为资料。 */
function checkUnavailablePage(title, body) {
  const shortBody = String(body || '').replace(/\s+/g, ' ').trim();
  const titleText = String(title || '').trim();
  if (/^页面没有找到$|^404\b|not found/i.test(titleText) && shortBody.length < 500) return true;
  if (/^页面没有找到\b|^404\b|not found/i.test(shortBody) && shortBody.length < 500) return true;
  return false;
}

/** Chrome MCP 可用时才提供切换建议，避免推荐用户未启用的能力。 */
function blockedHint() {
  if (!isChromeMcpAvailable()) return '';
  return '\n\n⚠️ 页面可能被反爬拦截，建议改用 Chrome MCP 工具（chrome_call_tool → navigate_page / take_snapshot）操作真实 Chrome 浏览器访问。';
}

/** 正文模式压缩空白并限长；链接模式返回前十条链接和短摘要，控制模型上下文大小。 */
async function extractPageTextOrLinks(view, url, extractLinks, signal?: AbortSignal) {
  if (extractLinks) {
    const { content, links } = await safeEvaluate(view, `(() => {
      const bodyText = document.body?.innerText || '';
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const extracted = [];
      for (const a of anchors) {
        const href = a.href;
        const label = (a.textContent || '').trim();
        if (href && href.startsWith('http') && label.length > 3 && label.length < 120) {
          extracted.push({ url: href, title: label });
        }
      }
      return { content: bodyText, links: extracted };
    })()`, signal);
    let result = `搜索结果 ${url}:\n\n链接列表:\n`;
    for (const link of links.slice(0, 10)) {
      result += `- [${link.title}](${link.url})\n`;
    }
    result += `\n页面摘要: ${content.slice(0, 3000)}`;
    return result;
  }

  const text = await safeEvaluate(view, "document.body?.innerText || ''", signal);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 24000
    ? cleaned.slice(0, 24000) + '\n...(内容已截断)'
    : cleaned;
}

/**
 * 动作统一入口：绑定取消、执行动作，并将普通错误转换成结构化失败。
 * 会话失效必须保留为异常，让管理器恢复；不能仅凭消息里的 timeout/navigation 将其吞掉。
 */
export async function executeBrowserAction(view, action, opts: { signal?: AbortSignal; recoveryAttempt?: number } = {}) {
  const signal = opts.signal;
  // 先检查取消再获取兜底实例，防止排队中的旧动作在停止之后新建一个无主 WebView。
  throwIfAborted(signal);
  const activeView = view || getWebView();
  let rejectAbort: ((reason?: any) => void) | null = null;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    // stop() 只中止加载，不能保证已播放的媒体停止；与会话管理器共用幂等 close。
    void closeBrowserSession(activeView);
    rejectAbort?.(signal?.reason instanceof Error ? signal.reason : new Error('Agent 已取消'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    if (!signal) return await _executeBrowserAction(activeView, action, opts);
    const result = await Promise.race([
      _executeBrowserAction(activeView, action, opts),
      abortPromise,
    ]);
    throwIfAborted(signal);
    return result;
  } catch (err) {
    throwIfAborted(signal);
    if (isClosedViewError(err)) throw err;
    const msg = err.message || String(err);
    if (/timeout|waiting for|not found|selector|元素不存在/i.test(msg)) {
      return failedResult(`浏览器操作失败: ${msg.slice(0, 200)}。可能原因: 元素不存在或页面未加载完成，请重新观察页面后使用 observation 中存在的 elementId。`, msg);
    }
    if (/execution context was destroyed|net::err_|connection.*closed|navigation/i.test(msg)) {
      return failedResult(`浏览器操作失败: ${msg.slice(0, 200)}。可能原因: 页面导航失败或连接中断，请尝试重新打开页面或使用其他网站。`, msg);
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 按动作分派具体操作；会话创建/恢复和任务收尾由外层管理器负责。 */
async function _executeBrowserAction(view, action, opts: { recoveryAttempt?: number; signal?: AbortSignal } = {}) {
  const signal = opts.signal;
  throwIfAborted(signal);
  if (action.type === 'navigate') {
    // 只打开页面并报告可访问性；正文由后续读取动作获取。
    // 内置浏览器不支持 file:// 协议，拦截并给出可操作建议
    if (/^(file:\/\/|https?:\/\/file)/.test(action.url || '')) {
      const localPath = (action.url || '').replace(/^https?:\/\/file\/\/\/|^file:\/\/\/?/, '/');
      return `内置浏览器不支持打开本地文件。请使用 notify_user 告知用户文件路径（${localPath}），或使用 terminal run_confirmed 执行 open "${localPath}" 让系统默认浏览器打开。`;
    }
    if (isBlockedSearchEngineUrl(action.url)) {
      return failedResult(blockedSearchEngineResult(action.url), '已阻止访问搜索引擎搜索页');
    }
    try {
      const firstTimeout = action.timeoutMs || FETCH_TIMEOUT_MS;
      const retryTimeout = action.timeoutMs ? Math.max(firstTimeout, Math.round(firstTimeout * 1.7)) : FETCH_TIMEOUT_RETRY_MS;
      await navigateWithRecoveryTimeout(view, action.url, firstTimeout, retryTimeout, `导航超时: ${action.url}`, opts.recoveryAttempt, signal);
      await delay(ACTION_SETTLE_MS, signal);
      try {
        const { title, url, body } = await detectBlockedPage(view, signal);
        if (checkBlocked(title, url, body)) {
          return `已打开 ${action.url}，但页面可能被反爬拦截（标题: ${title.slice(0, 80)}）。${blockedHint()}`;
        }
      } catch (err) {
        // 页面检查本身可失败，但会话已关闭时不能继续报告“已打开”。
        throwIfAborted(signal);
        if (isClosedViewError(err)) throw err;
      }
      return `已打开 ${action.url}`;
    } catch (err) {
      throwIfAborted(signal);
      if (isClosedViewError(err)) throw err;
      return failedResult(`无法打开 ${action.url}: ${err.message?.slice(0, 150) || '连接失败'}。请尝试其他网址或使用 fetch 工具。`, err.message || '连接失败');
    }
  }

  if (action.type === 'click') {
    // 兼容旧 trace/checkpoint 或过期客户端：保留动作识别，但绝不在内置 WebView 中执行交互。
    return failedResult(
      '内置浏览器是只读信息浏览器，不支持点击操作。请启用并使用 Chrome MCP（chrome_call_tool）。',
      '内置浏览器不支持交互操作',
    );
  }

  if (action.type === 'type') {
    // 与 click 一样只做明确拒绝；网页输入和提交统一交给 Chrome MCP。
    return failedResult(
      '内置浏览器是只读信息浏览器，不支持输入或提交操作。请启用并使用 Chrome MCP（chrome_call_tool）。',
      '内置浏览器不支持交互操作',
    );
  }

  if (action.type === 'wait') {
    // 等待站点异步渲染；沿用任务取消信号，不占着定时器等待到期。
    await delay(action.seconds * 1000, signal);
    return `已等待 ${action.seconds} 秒`;
  }

  if (action.type === 'scroll') {
    // 以 300px 为一步滚动，比较前后正文变化，提示是否触发了懒加载。
    const pixels = (action.amount || 3) * 300;
    const signedPixels = action.direction === 'up' ? -pixels : pixels;
    // 滚动前后各取一次文本快照，用于判断懒加载是否真的触发
    const beforeText = await safeEvaluate(view, "(document.body?.innerText || '').slice(0, 4000)", signal);
    await safeEvaluate(view, `window.scrollBy(0, ${signedPixels})`, signal);
    // 1200ms 比原 400ms 更稳，给懒加载/异步渲染留时间
    await delay(1200, signal);
    const afterText = await safeEvaluate(view, "(document.body?.innerText || '').slice(0, 4000)", signal);
    let result = `已向${action.direction === 'up' ? '上' : '下'}滚动 ${action.amount || 3} 步`;
    const lengthDelta = Math.abs((afterText?.length || 0) - (beforeText?.length || 0));
    const unchanged =
      beforeText && afterText &&
      lengthDelta < 20 &&
      beforeText.slice(0, 200) === afterText.slice(0, 200) &&
      beforeText.slice(-200) === afterText.slice(-200);
    if (unchanged) {
      result += '\n⚠️ 滚动后页面内容未变化（可能已到底部或懒加载未触发）';
    }
    return result;
  }

  if (action.type === 'get_page_content') {
    // 读取当前页面，不重新导航；此动作提供较短的正文窗口。
    const text = await safeEvaluate(view, "document.body?.innerText || ''", signal);
    return text.slice(0, 12000) || '页面内容为空';
  }

  if (action.type === 'finish') {
    // 兼容旧 browser.finish 动作；关闭浏览器统一由 runtime 的任务收尾触发。
    return action.answer || '任务已完成';
  }

  if (action.type === 'http_fetch') {
    // 使用 WebView 加载并执行页面脚本，再检查反爬/404 并提取正文；不是原始 HTTP 请求。
    if (!action.url) throw new Error('http_fetch 缺少 url');
    const url = normalizeHttpUrl(action.url);
    if (isBlockedSearchEngineUrl(url)) {
      return failedResult(blockedSearchEngineResult(url), '已阻止访问搜索引擎搜索页');
    }
    try {
      const firstTimeout = action.timeoutMs || FETCH_TIMEOUT_MS;
      const retryTimeout = action.timeoutMs ? Math.max(firstTimeout, Math.round(firstTimeout * 1.7)) : FETCH_TIMEOUT_RETRY_MS;
      await navigateWithRecoveryTimeout(view, url, firstTimeout, retryTimeout, `访问超时: ${url}`, opts.recoveryAttempt, signal);
      await delay(1000, signal);
    } catch (err) {
      throwIfAborted(signal);
      if (isClosedViewError(err)) throw err;
      const error = (err.message || '').slice(0, 120);
      return failedResult(`http_fetch ${url}: 浏览器访问失败 (${error})。`, error);
    }
    try {
      const pageInfo = await detectBlockedPage(view, signal);
      if (checkBlocked(pageInfo.title, pageInfo.url, pageInfo.body)) {
        const message = `http_fetch ${url} 被反爬拦截（标题: ${pageInfo.title.slice(0, 80)}）。${blockedHint()}`;
        return failedResult(message, '页面被反爬拦截');
      }
      if (checkUnavailablePage(pageInfo.title, pageInfo.body)) {
        const body = String(pageInfo.body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        return failedResult(`http_fetch ${url}: 页面不可用（标题: ${pageInfo.title.slice(0, 80)}）。${body}`, '页面不可用');
      }
    } catch (err) {
      // 普通检查错误仍允许尝试提取；会话失效应先交给管理器恢复，不能读取旧页面。
      throwIfAborted(signal);
      if (isClosedViewError(err)) throw err;
    }
    const content = await extractPageTextOrLinks(view, url, action.extractLinks, signal);
    if (!content) {
      return failedResult(`http_fetch ${url}: 页面内容为空。`, '页面内容为空');
    }
    return content;
  }

  throw new Error(`不支持的动作类型: ${action.type}`);
}
