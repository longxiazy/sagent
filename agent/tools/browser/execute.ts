import { getWebView } from './webview-session.ts';
import { isChromeMcpAvailable } from '../chrome/mcp-client.ts';

const ACTION_SETTLE_MS = 600;
const NAV_RETRY_MS = 500;
const NAV_MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_RETRY_MS = 25000;
const BROWSER_SESSION_INVALID_CODE = 'BROWSER_SESSION_INVALID';

const SEARCH_ENGINE_HOSTS = [
  /(^|\.)baidu\.com$/i,
  /(^|\.)google\.[^/]+$/i,
  /(^|\.)bing\.com$/i,
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isClosedViewError(err) {
  return err?.code === BROWSER_SESSION_INVALID_CODE
    || /view is closed|invalid state.*webview/i.test(String(err?.message || err || ''));
}

function invalidBrowserSessionError(message) {
  const err: any = new Error(message);
  err.code = BROWSER_SESSION_INVALID_CODE;
  return err;
}

function stopView(view) {
  try {
    if (typeof view?.stop === 'function') return view.stop();
    if (typeof view?.close === 'function') return view.close();
  } catch {}
}

function withTimeout(promise, ms, message, onTimeout = null, invalidateSession = false) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(invalidateSession ? invalidBrowserSessionError(message) : new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    // Give the underlying operation time to settle so WebView clears its pending state
    return promise.catch(() => {});
  });
}

function normalizeHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
}

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

function blockedSearchEngineResult(url) {
  return [
    `已阻止访问搜索引擎搜索页: ${url}`,
    'Google、百度、Bing 等搜索页容易触发反爬/验证码，且通常不是可靠的一手来源。',
    '请直接抓取目标站点 URL；如果需要多源搜索，请先筛选候选来源，再逐个使用 http_fetch。',
  ].join('\n');
}

function failedResult(result, error = result) {
  return {
    result,
    resultStatus: 'failed',
    resultError: String(error || result),
  };
}

// 导航超时会让当前 Bun.WebView 进入不可信状态。关闭并上抛会话失效，
// 由 browser-session-manager 创建新实例；禁止在同一个已关闭实例上重试。
async function navigateWithRecoveryTimeout(view, url, firstTimeoutMs, retryTimeoutMs, errMessage, recoveryAttempt = 0) {
  const timeoutMs = recoveryAttempt > 0 ? retryTimeoutMs : firstTimeoutMs;
  return withTimeout(
    safeNavigate(view, url),
    timeoutMs,
    `${errMessage}${recoveryAttempt > 0 ? '（恢复会话后仍超时）' : ''}`,
    () => stopView(view),
    true,
  );
}

export async function safeNavigate(view, url) {
  for (let i = 0; i < NAV_MAX_RETRIES + 5; i++) {
    try {
      return await view.navigate(url);
    } catch (err) {
      if (/already pending/i.test(err.message)) {
        await delay(1000);
        continue;
      }
      throw err;
    }
  }
}

async function safeEvaluate(view, script) {
  for (let i = 0; i < NAV_MAX_RETRIES; i++) {
    try {
      return await view.evaluate(script);
    } catch (err) {
      if (/already pending/i.test(err.message) && i < NAV_MAX_RETRIES - 1) {
        await delay(NAV_RETRY_MS);
        continue;
      }
      throw err;
    }
  }
}

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

function detectBlockedPage(view) {
  return view.evaluate(`(() => {
    const title = document.title || '';
    const url = window.location.href || '';
    const body = (document.body?.innerText || '').slice(0, 2000);
    return { title, url, body };
  })()`);
}

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

function checkUnavailablePage(title, body) {
  const shortBody = String(body || '').replace(/\s+/g, ' ').trim();
  const titleText = String(title || '').trim();
  if (/^页面没有找到$|^404\b|not found/i.test(titleText) && shortBody.length < 500) return true;
  if (/^页面没有找到\b|^404\b|not found/i.test(shortBody) && shortBody.length < 500) return true;
  return false;
}

function blockedHint() {
  if (!isChromeMcpAvailable()) return '';
  return '\n\n⚠️ 页面可能被反爬拦截，建议改用 Chrome MCP 工具（chrome_call_tool → navigate_page / take_snapshot）操作真实 Chrome 浏览器访问。';
}

async function extractPageTextOrLinks(view, url, extractLinks) {
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
    })()`);
    let result = `搜索结果 ${url}:\n\n链接列表:\n`;
    for (const link of links.slice(0, 10)) {
      result += `- [${link.title}](${link.url})\n`;
    }
    result += `\n页面摘要: ${content.slice(0, 3000)}`;
    return result;
  }

  const text = await safeEvaluate(view, "document.body?.innerText || ''");
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 24000
    ? cleaned.slice(0, 24000) + '\n...(内容已截断)'
    : cleaned;
}

export async function executeBrowserAction(view, action, opts: { signal?: AbortSignal; recoveryAttempt?: number } = {}) {
  const activeView = view || getWebView();
  const signal = opts.signal;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Agent 已取消');
  let rejectAbort: ((reason?: any) => void) | null = null;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    stopView(activeView);
    rejectAbort?.(signal?.reason instanceof Error ? signal.reason : new Error('Agent 已取消'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (!signal) return await _executeBrowserAction(activeView, action, opts);
    return await Promise.race([
      _executeBrowserAction(activeView, action, opts),
      abortPromise,
    ]);
  } catch (err) {
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

async function _executeBrowserAction(view, action, opts: { recoveryAttempt?: number } = {}) {
  if (action.type === 'navigate') {
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
      await navigateWithRecoveryTimeout(view, action.url, firstTimeout, retryTimeout, `导航超时: ${action.url}`, opts.recoveryAttempt);
      await delay(ACTION_SETTLE_MS);
      try {
        const { title, url, body } = await detectBlockedPage(view);
        if (checkBlocked(title, url, body)) {
          return `已打开 ${action.url}，但页面可能被反爬拦截（标题: ${title.slice(0, 80)}）。${blockedHint()}`;
        }
      } catch { /* ignore detection failure */ }
      return `已打开 ${action.url}`;
    } catch (err) {
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
    await delay(action.seconds * 1000);
    return `已等待 ${action.seconds} 秒`;
  }

  if (action.type === 'scroll') {
    const pixels = (action.amount || 3) * 300;
    const signedPixels = action.direction === 'up' ? -pixels : pixels;
    // 滚动前后各取一次文本快照，用于判断懒加载是否真的触发
    const beforeText = await safeEvaluate(view, "(document.body?.innerText || '').slice(0, 4000)");
    await safeEvaluate(view, `window.scrollBy(0, ${signedPixels})`);
    // 1200ms 比原 400ms 更稳，给懒加载/异步渲染留时间
    await delay(1200);
    const afterText = await safeEvaluate(view, "(document.body?.innerText || '').slice(0, 4000)");
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
    const text = await safeEvaluate(view, "document.body?.innerText || ''");
    return text.slice(0, 12000) || '页面内容为空';
  }

  if (action.type === 'finish') {
    return action.answer || '任务已完成';
  }

  if (action.type === 'http_fetch') {
    if (!action.url) throw new Error('http_fetch 缺少 url');
    const url = normalizeHttpUrl(action.url);
    if (isBlockedSearchEngineUrl(url)) {
      return failedResult(blockedSearchEngineResult(url), '已阻止访问搜索引擎搜索页');
    }
    try {
      const firstTimeout = action.timeoutMs || FETCH_TIMEOUT_MS;
      const retryTimeout = action.timeoutMs ? Math.max(firstTimeout, Math.round(firstTimeout * 1.7)) : FETCH_TIMEOUT_RETRY_MS;
      await navigateWithRecoveryTimeout(view, url, firstTimeout, retryTimeout, `访问超时: ${url}`, opts.recoveryAttempt);
      await delay(1000);
    } catch (err) {
      if (isClosedViewError(err)) throw err;
      const error = (err.message || '').slice(0, 120);
      return failedResult(`http_fetch ${url}: 浏览器访问失败 (${error})。`, error);
    }
    try {
      const pageInfo = await detectBlockedPage(view);
      if (checkBlocked(pageInfo.title, pageInfo.url, pageInfo.body)) {
        const message = `http_fetch ${url} 被反爬拦截（标题: ${pageInfo.title.slice(0, 80)}）。${blockedHint()}`;
        return failedResult(message, '页面被反爬拦截');
      }
      if (checkUnavailablePage(pageInfo.title, pageInfo.body)) {
        const body = String(pageInfo.body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        return failedResult(`http_fetch ${url}: 页面不可用（标题: ${pageInfo.title.slice(0, 80)}）。${body}`, '页面不可用');
      }
    } catch { /* ignore detection failure */ }
    const content = await extractPageTextOrLinks(view, url, action.extractLinks);
    if (!content) {
      return failedResult(`http_fetch ${url}: 页面内容为空。`, '页面内容为空');
    }
    return content;
  }

  throw new Error(`不支持的动作类型: ${action.type}`);
}
