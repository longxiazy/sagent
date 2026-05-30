import {
  formatChromeMcpError,
  getSharedChromeMcpClient,
  isChromeMcpEnabled,
  loadChromeMcpConfig,
  serializeChromePayload,
  summarizeChromeTool,
} from './mcp-client.ts';
import { withBrowserLock } from './browser-lock.ts';

const MAX_TEXT = 48000;
const SEARCH_ENGINE_HOSTS = [
  /(^|\.)baidu\.com$/i,
  /(^|\.)google\.[^/]+$/i,
  /(^|\.)bing\.com$/i,
];

function truncate(text, max = MAX_TEXT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n...(内容已截断)` : value;
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
    '请直接抓取目标站点 URL；如果需要多源搜索，请使用 browser.parallel_fetch 抓取多个候选来源页面。',
  ].join('\n');
}

// 当前 snapshot 的 id（uid 的下划线前缀）。
// chrome-devtools-mcp 每次 take_snapshot 都会生成新的递增 snapshotId，
// 旧 uid 在新 snapshot 下指向不存在的节点——继续 click 会"成功"但点到错的元素。
let currentSnapshotId: string | null = null;

export function resetChromeSnapshotState() {
  currentSnapshotId = null;
}

const UID_TOOL_FIELDS: Record<string, string[]> = {
  click: ['uid'],
  fill: ['uid'],
  hover: ['uid'],
  upload_file: ['uid'],
  take_screenshot: ['uid'],
  drag: ['from_uid', 'to_uid'],
};

// 这些工具需要先有一个"非空白"的目标页面才有意义；裸调（chrome 刚启动只剩 about:blank）
// 会返回一个几乎为空的 a11y tree，让模型误以为页面加载失败或抓取不到。前置 list_pages 探测引导先 navigate。
const PAGE_REQUIRED_TOOLS = new Set([
  'take_snapshot',
  'take_screenshot',
]);

const BLANK_PAGE_URL_RE = /^(?:about:blank|chrome:\/\/(?:newtab|new-tab-page|new-tab-page-third-party)|chrome-search:|edge:\/\/newtab)/i;

function isBlankPageUrl(url: string): boolean {
  return !url || BLANK_PAGE_URL_RE.test(url.trim());
}

function extractSelectedPageUrl(pagesText: string): string | null {
  // list_pages 输出形如：
  //   ## Pages
  //   0: https://example.com [selected]
  //   1: about:blank
  const m = /^\s*\d+:\s*(\S+)\s*\[selected\]/m.exec(pagesText || '');
  return m ? m[1] : null;
}

function blankPageGuideMessage(toolName: string, pagesText: string): string {
  return [
    `Chrome 工具 ${toolName} 已拒绝执行：当前没有打开任何有效页面（仅空白页/新标签页）。`,
    '请先调用 chrome_call_tool toolName=navigate_page arguments={"url":"目标网址"} 打开目标页面，然后再调用本工具。',
    'navigate_page 成功后会自动夹带页面快照，通常无需再单独 take_snapshot。',
    '',
    `当前页面列表:\n${pagesText || '(list_pages 无内容)'}`,
  ].join('\n');
}

// take_snapshot 返回的 a11y tree。about:blank/newtab 只有 RootWebArea + 0~1 子节点，
// 节点稀少时当成"没真正加载到内容"，给模型一个明确信号而不是看似成功但空白的结果。
function isTrivialSnapshotContent(content: string): boolean {
  const uidLines = (content || '').split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('uid='));
  return uidLines.length > 0 && uidLines.length <= 2;
}

function extractSnapshotIdFromText(text: string): string | null {
  // chrome-devtools-mcp 的 click/fill 等动作响应里会同时引用"旧 uid"（被作用的元素）
  // 和"新 snapshot 的 uid"，例如：
  //   clicked uid=3_5 successfully
  //   # Snapshot
  //   uid=4_0 RootWebArea ...
  // 取第一个 uid 会拿到旧的 3；snapshot id 单调递增，取所有 uid 里最大的 sid 才是最新 snapshot。
  let maxId = -1;
  for (const m of (text || '').matchAll(/\buid=(\d+)_\d+/g)) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && id > maxId) maxId = id;
  }
  return maxId >= 0 ? String(maxId) : null;
}

function snapshotIdOfUid(uid: unknown): string | null {
  if (typeof uid !== 'string') return null;
  const m = /^(\d+)_\d+$/.exec(uid.trim());
  return m ? m[1] : null;
}

function isNavigationTimeoutResult(result: any): boolean {
  // chrome-devtools-mcp 的 navigate_page 超时常以 isError + "Navigation timeout" 文案返回。
  if (!result?.isError) return false;
  const text = Array.isArray(result?.content)
    ? result.content.map((c: any) => c?.text || '').join(' ')
    : '';
  return /Navigation timeout|timeout of \d+\s*ms exceeded|Unable to navigate/i.test(text);
}

function validateUidsAgainstSnapshot(toolName: string, args: Record<string, any>): string | null {
  const fields = UID_TOOL_FIELDS[toolName];
  if (!fields || !currentSnapshotId) return null;
  const currentNum = Number(currentSnapshotId);
  for (const field of fields) {
    const value = args?.[field];
    if (value == null || value === '') continue;
    const sid = snapshotIdOfUid(value);
    if (!sid) {
      return `参数 ${field}="${value}" 不是合法的 uid（应为形如 "3_12" 的字符串）。请先 take_snapshot 获取最新 uid。`;
    }
    if (sid === currentSnapshotId) continue;
    // 容错：snapshot id 单调递增。如果传入 uid 的 sid 比 currentSnapshotId 更新（>=），
    // 说明 client 端 extract 没跟上 chrome 真实的新 snapshot——把 uid 当成权威，自动升级。
    const sidNum = Number(sid);
    if (Number.isFinite(sidNum) && Number.isFinite(currentNum) && sidNum >= currentNum) {
      currentSnapshotId = sid;
      continue;
    }
    return `参数 ${field}="${value}" 属于旧 snapshot (id=${sid})，当前 snapshot id=${currentSnapshotId}；snapshot 重建后旧 uid 已失效，请先 take_snapshot 取最新 uid 再调用。`;
  }
  return null;
}

function formatToolList(tools, config) {
  // chrome_list_tools 面向模型展示工具摘要，只保留名称、参数字段和描述。
  const header = [
    `Chrome DevTools MCP 已连接 (${config.transport})`,
    `可用工具数: ${tools.length}`,
  ].join('\n');

  const lines = tools.map(tool => {
    const summary = summarizeChromeTool(tool);
    const args = summary.fields ? ` (${summary.fields})` : '';
    return `- ${summary.name}${args}${summary.description ? `: ${summary.description}` : ''}`;
  });

  return truncate(`${header}\n\n${lines.join('\n') || '当前未发现可用 Chrome 工具'}`);
}

function extractToolContent(result) {
  // MCP 工具结果可能同时包含 content 和 structuredContent，这里统一压成文本。
  const chunks = [];

  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && item.text) {
        chunks.push(item.text);
        continue;
      }
      chunks.push(serializeChromePayload(item));
    }
  }

  if (result?.structuredContent !== undefined) {
    chunks.push(serializeChromePayload(result.structuredContent));
  }

  if (chunks.length === 0) {
    chunks.push(serializeChromePayload(result));
  }

  return chunks.join('\n\n');
}

export async function executeChromeAction(action) {
  // 浏览器是进程单例（共享 MCP 连接 + 模块级 currentSnapshotId），多 run 并发会互踩。
  // 串行化：同一时刻只有一个 run 操作浏览器，其余排队。释放锁时重置 snapshot 状态，
  // 避免上一个 run 的 snapshotId 泄漏给下一个 run。
  return withBrowserLock(
    () => executeChromeActionLocked(action),
    {
      signal: action?.cancelSignal,
      onRelease: resetChromeSnapshotState,
    },
  );
}

async function executeChromeActionLocked(action) {
  if (!isChromeMcpEnabled()) {
    throw new Error('Chrome MCP 未启用，请在 .env 中设置 CHROME_MCP_ENABLED=true 并配置连接参数');
  }

  const config = loadChromeMcpConfig();
  if (action.type === 'chrome_call_tool') {
    const toolName = String(action.toolName || '').trim();
    const args = action.arguments && typeof action.arguments === 'object' && !Array.isArray(action.arguments)
      ? action.arguments : {};
    const targetUrl = typeof args.url === 'string' ? args.url : '';
    if ((toolName === 'navigate_page' || toolName === 'new_page') && isBlockedSearchEngineUrl(targetUrl)) {
      return blockedSearchEngineResult(targetUrl);
    }
  }

  let client;
  try {
    // 复用共享 MCP client，避免每次 Chrome 动作都重新拉起 MCP 进程或 SSE 流。
    client = await getSharedChromeMcpClient(config);
  } catch (err: any) {
    if (err.message?.includes('error -54') || err.message?.includes('xattr')) {
      return [
        '⚠️ Chrome 浏览器因 macOS 权限问题无法启动（error -54）',
        '已自动回退到内置 HTTP 客户端，可继续使用 browser.http_fetch 等工具。',
        '如需修复 Chrome，请在终端执行:',
        '  xattr -cr /Applications/Google\\ Chrome.app',
      ].join('\n');
    }
    throw err;
  }

  if (action.type === 'chrome_list_tools') {
    const tools = await client.listTools({ refresh: Boolean(action.refresh) });
    return formatToolList(tools, config);
  }

  if (action.type === 'chrome_call_tool') {
    const toolName = String(action.toolName || '').trim();
    if (!toolName) {
      throw new Error('chrome_call_tool 缺少 toolName');
    }

    const tool = await client.getTool(toolName, { refresh: Boolean(action.refreshTools) });
    if (!tool) {
      throw new Error(`未找到 Chrome 工具 ${toolName}，请先调用 chrome_list_tools 确认可用工具名`);
    }

    const rawArgs = action.arguments && typeof action.arguments === 'object' && !Array.isArray(action.arguments)
      ? action.arguments : {};
    const args = { ...rawArgs };

    // navigate_page 默认 10s 对国内重型门户站太短（IBKR、招行等首屏 >10s）。
    // 模型未显式传 timeout 时，补到 25s；超时后我们还会兜底处理（见下方 busy 检测）。
    const NAVIGATE_DEFAULT_TIMEOUT_MS = Number(process.env.CHROME_MCP_NAVIGATE_TIMEOUT_MS) || 25000;
    if ((toolName === 'navigate_page' || toolName === 'new_page')
        && (args as any).timeout == null) {
      (args as any).timeout = NAVIGATE_DEFAULT_TIMEOUT_MS;
    }

    // uid 过期硬校验：snapshot 重建后旧 uid 会"成功"点到错位置，必须显式拒掉。
    const uidErr = validateUidsAgainstSnapshot(toolName, args);
    if (uidErr) {
      return truncate([
        `Chrome 工具 ${toolName} 已拒绝执行：uid 过期`,
        `参数: ${serializeChromePayload(args)}`,
        `原因: ${uidErr}`,
      ].join('\n\n'));
    }

    // 前置防线：take_snapshot / take_screenshot 类工具裸调（没先 navigate）会拿到 about:blank 的空快照，
    // 模型/用户难以察觉这是"页面没打开"还是"页面真的空"。先 list_pages 探一下，
    // 选中页是空白页就直接返回引导文案，不浪费一次工具调用。
    if (PAGE_REQUIRED_TOOLS.has(toolName)) {
      try {
        const pagesResult = await client.callTool('list_pages', {});
        if (!pagesResult?.isError) {
          const pagesText = extractToolContent(pagesResult);
          const selectedUrl = extractSelectedPageUrl(pagesText);
          if (!selectedUrl || isBlankPageUrl(selectedUrl)) {
            return truncate(blankPageGuideMessage(toolName, pagesText));
          }
        }
      } catch {
        // list_pages 失败不阻断，让原工具调用走原始报错路径。
      }
    }

    let result;
    try {
      // 这里保留原始 MCP tool 调用语义，错误恢复由 mcp-client.ts 统一处理。
      result = await client.callTool(toolName, args);
    } catch (err: any) {
      if (err.message?.includes('error -54') || err.message?.includes('xattr')) {
        return [
          '⚠️ Chrome 浏览器因 macOS 权限问题无法启动（error -54）',
          '已自动回退到内置 HTTP 客户端，可继续使用 browser.http_fetch 等工具。',
          '如需修复 Chrome，请在终端执行:',
          '  xattr -cr /Applications/Google\\ Chrome.app',
        ].join('\n');
      }
      throw err;
    }

    // navigate_page 超时 ≠ 失败：很多重型站点首屏渲染慢，但 DOM 已可交互。
    // 主动再 take_snapshot，若页面已 idle（不再 busy），把结果改成"导航完成（超时但已加载）"。
    if ((toolName === 'navigate_page' || toolName === 'new_page') && isNavigationTimeoutResult(result)) {
      try {
        const probe = await client.callTool('take_snapshot', {});
        const probeContent = extractToolContent(probe);
        const sid = extractSnapshotIdFromText(probeContent);
        if (sid) currentSnapshotId = sid;
        const stillBusy = /\bbusy\b/.test(probeContent);
        if (!stillBusy) {
          return truncate([
            `Chrome 工具 ${toolName} 执行完成（导航超时但页面已加载完成）`,
            `参数: ${serializeChromePayload(args)}`,
            `结果:\n首屏渲染超过 ${(args as any).timeout}ms，但 DOM 已就绪，可直接继续操作。`,
            `\n[页面快照]\n${probeContent}`,
          ].join('\n\n'));
        }
        // 仍在 busy：返回明确的"仍在加载"信号，模型应等待或再 take_snapshot 轮询，而非视为失败。
        return truncate([
          `Chrome 工具 ${toolName} 导航中（页面仍在加载，busy=true）`,
          `参数: ${serializeChromePayload(args)}`,
          `结果:\n导航请求已发出但首屏未完成。请稍后再次 take_snapshot 或 wait_for 关键元素，不要重复 navigate_page。`,
          `\n[当前快照]\n${probeContent}`,
        ].join('\n\n'));
      } catch {
        // probe 失败就走原始失败路径
      }
    }
    const content = extractToolContent(result);
    const status = result?.isError ? '失败' : '完成';

    // 后置兜底：前置 list_pages 可能误判（pageId 路由失效 / 探测失败），take_snapshot 返回的 a11y tree
    // 若只剩 RootWebArea + 0~1 节点，说明实际就是空白页，把"看似成功但空"改写成引导文案。
    if (!result?.isError && toolName === 'take_snapshot' && isTrivialSnapshotContent(content)) {
      return truncate([
        `Chrome 工具 take_snapshot 执行完成但页面内容为空（疑似 about:blank/新标签页）。`,
        '请先调用 chrome_call_tool toolName=navigate_page arguments={"url":"目标网址"} 打开目标页面。',
        '',
        `原始 snapshot:\n${content}`,
      ].join('\n\n'));
    }

    const parts = [
      `Chrome 工具 ${toolName} 执行${status}`,
      `参数: ${serializeChromePayload(args)}`,
      `结果:\n${content}`,
    ];

    // navigate_page / new_page 成功后自动获取页面快照，让 LLM 立即看到页面内容
    const NAVIGATE_TOOLS = new Set(['navigate_page', 'new_page']);
    if (!result?.isError && NAVIGATE_TOOLS.has(toolName)) {
      try {
        const snapshotResult = await client.callTool('take_snapshot', {});
        const snapshotContent = extractToolContent(snapshotResult);
        parts.push(`\n[页面快照]\n${snapshotContent}`);
        const sid = extractSnapshotIdFromText(snapshotContent);
        if (sid) currentSnapshotId = sid;
      } catch {
        parts.push('\n[页面快照获取失败，页面可能仍在加载]');
      }
    } else if (!result?.isError) {
      // take_snapshot 自身、以及 click/fill 等带 includeSnapshot=true 的工具，
      // 都会在 content 里夹带新 snapshot——同步刷新 currentSnapshotId。
      const sid = extractSnapshotIdFromText(content);
      if (sid) currentSnapshotId = sid;
    }

    return truncate(parts.join('\n\n'));
  }

  throw new Error(formatChromeMcpError(new Error(`不支持的 Chrome 动作类型: ${action.type}`), 'Chrome MCP'));
}
