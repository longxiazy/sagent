import { buildIdePromptLines, isIdeMcpEnabled } from '../tools/ide/mcp-client.ts';
import { buildChromePromptLines, isChromeMcpAvailable } from '../tools/chrome/mcp-client.ts';
import { isGenericMcpEnabled, listGenericMcpServers } from '../tools/mcp/client.ts';
import { configStore } from './config-store.ts';
import { createModelTools, toolToGeminiTool } from './tool-definitions.ts';
import { compactToolResult } from './result-extraction.ts';

type PromptCapabilityContext = {
  task?: string;
  history?: any[];
  observation?: any;
  conversationHistory?: Array<{ role?: string; content?: string }>;
  includeInactiveCapabilityHints?: boolean;
};

const CHROME_TASK_RE = /\bchrome\b|devtools|开发者工具|真实浏览器|网络面板|performance|lighthouse|控制台|console/i;
const IDE_TASK_RE = /\bide\b|jetbrains|intellij|webstorm|pycharm|goland|运行配置|重命名重构|代码检查/i;
const GENERIC_MCP_TASK_RE = /\bmcp\b|codex|编码专家|coding expert|外部工具|工具服务器/i;
const BROWSER_BLOCK_RE = /captcha|cloudflare|403|forbidden|人机验证|反爬|访问受限|被拦截|blocked/i;
const WEB_TASK_RE = /https?:\/\/|\bwww\.|\bweb\b|browser|website|search|news|weather|price|flight|hotel|online|网页|浏览器|网站|上网|搜索|查询|新闻|天气|实时|价格|机票|航班|酒店|电商|官网/i;
const FILE_TASK_RE = /\b(project|repo|repository|code|source|file|folder|directory|path|config|dependency|readme)\b|项目|仓库|代码|源码|文件|文件夹|目录|路径|配置|依赖|模块|读取|写入|修改|编辑|创建|删除|重命名|查找|修复/i;
const TERMINAL_TASK_RE = /\b(shell|terminal|command|npm|pnpm|yarn|bun|git|curl|build|test|lint|install|process|server|log|pull|push|commit|merge|branch|checkout|deploy)\b|命令|终端|运行|执行|构建|测试|安装|启动|停止|服务|进程|日志|拉取|提交|推送|合并|分支|部署/i;
const VISION_TASK_RE = /\[附件\]|\.(?:png|jpe?g|gif|webp|bmp|heic)(?:\b|\?)|\b(image|photo|picture|screenshot|ocr|vision)\b|图片|图像|照片|截图|识图|看图|图里|图中/i;
const FOLLOWUP_TASK_RE = /^\s*(?:(?:继续|接着|重试|再试|这个|那个|上面|刚才|照旧)(?:\s|$)|(?:continue|retry|that|it)\b)/i;

// web_search 作为轻量信息查询兜底常驻，避免产品目录、模型上下线、版本变化等
// 时效性问题未命中关键词分类后只剩 finish，导致模型把问题原样返回。
const CORE_TOOL_NAMES = ['web_search', 'ask_user', 'notify_user', 'finish'];
const WEB_TOOL_NAMES = ['navigate', 'click', 'type', 'wait', 'scroll', 'get_page_content', 'http_fetch', 'web_search'];
const FILE_TOOL_NAMES = ['list_dir', 'read_file', 'get_file_info', 'write_file', 'search_files', 'codegraph_query'];
const TERMINAL_TOOL_NAMES = ['run_safe', 'run_confirmed', 'run_review'];
const VISION_TOOL_NAMES = ['image_analyze'];
const IDE_TOOL_NAMES = ['ide_list_tools', 'ide_call_tool'];
const CHROME_TOOL_NAMES = ['chrome_list_tools', 'chrome_call_tool'];
const MCP_TOOL_NAMES = ['mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool'];

type NvidiaActionExample = {
  rationale: string;
  action: Record<string, unknown>;
  readonly?: boolean;
  capability?: 'ide' | 'chrome' | 'mcp';
};

const NVIDIA_ACTION_EXAMPLES: NvidiaActionExample[] = [
  { rationale: '打开网页', action: { tool: 'browser', type: 'navigate', url: 'https://example.com' } },
  { rationale: '点击网页元素', action: { tool: 'browser', type: 'click', elementId: '3' } },
  { rationale: '在网页输入框输入文字', action: { tool: 'browser', type: 'type', elementId: '3', text: 'hello', submit: true } },
  { rationale: '等待网页加载', action: { tool: 'browser', type: 'wait', seconds: 2 } },
  { rationale: '向下滚动页面', action: { tool: 'browser', type: 'scroll', direction: 'down', amount: 3 } },
  { rationale: '获取浏览器当前页面文本内容', action: { tool: 'browser', type: 'get_page_content' } },
  { rationale: '抓取网页内容', action: { tool: 'browser', type: 'http_fetch', url: 'https://example.com' } },
  { rationale: '搜索并提取链接', action: { tool: 'browser', type: 'http_fetch', url: 'https://example.com/search?q=关键词', extractLinks: true } },
  { rationale: '读取目录', action: { tool: 'fs', type: 'list_dir', path: '.' }, readonly: true },
  { rationale: '查看文件大小和修改时间', action: { tool: 'fs', type: 'get_file_info', path: 'README.md' }, readonly: true },
  { rationale: '读取文件', action: { tool: 'fs', type: 'read_file', path: 'README.md' }, readonly: true },
  { rationale: '写文件', action: { tool: 'fs', type: 'write_file', path: 'notes.txt', content: '内容', append: false } },
  { rationale: '搜索文件内容', action: { tool: 'fs', type: 'search_files', query: '关键词', path: '.', include: '*.js' }, readonly: true },
  { rationale: '运行只读命令', action: { tool: 'terminal', type: 'run_safe', command: 'pwd' } },
  { rationale: '运行需确认命令', action: { tool: 'terminal', type: 'run_confirmed', command: 'git status' } },
  { rationale: '切换目录', action: { tool: 'terminal', type: 'run_review', command: 'cd /path/to/dir' } },
  { rationale: '网络搜索关键词', action: { tool: 'search', type: 'web_search', query: '2026 北京最低工资标准' }, readonly: true },
  { rationale: '查询项目代码图谱定位相关模块', action: { tool: 'codegraph', type: 'codegraph_query', query: '记忆 memory' }, readonly: true },
  { rationale: '分析任务中的第一张附件图片', action: { tool: 'vision', type: 'image_analyze', image: '@attachment/1', question: '图片里有什么内容？请详细描述。' }, readonly: true },
  { rationale: '查看 IDE 可用工具', action: { tool: 'ide', type: 'ide_list_tools' }, capability: 'ide' },
  { rationale: '调用 IDE 工具获取运行配置', action: { tool: 'ide', type: 'ide_call_tool', toolName: 'get_run_configurations', arguments: {} }, capability: 'ide' },
  { rationale: '调用 Chrome 工具截图', action: { tool: 'chrome', type: 'chrome_call_tool', toolName: 'take_screenshot', arguments: {} }, capability: 'chrome' },
  { rationale: '刷新 Chrome 工具列表（仅在工具缺失或调用失败时使用）', action: { tool: 'chrome', type: 'chrome_list_tools', refresh: true }, capability: 'chrome' },
  { rationale: '查看通用 MCP server', action: { tool: 'mcp', type: 'mcp_list_servers' }, capability: 'mcp' },
  { rationale: '查看 Codex MCP 工具', action: { tool: 'mcp', type: 'mcp_list_tools', serverName: 'codex' }, capability: 'mcp' },
  { rationale: '调用 Codex 编码工具', action: { tool: 'mcp', type: 'mcp_call_tool', serverName: 'codex', toolName: 'codex', arguments: { prompt: '检查并修复测试失败' } }, capability: 'mcp' },
  { rationale: '向用户提问', action: { tool: 'core', type: 'ask_user', question: '你希望使用什么命名规范？' } },
  { rationale: '发现重要问题需告知用户', action: { tool: 'core', type: 'notify_user', message: '发现 3 个硬编码 API 密钥', level: 'warning' } },
  { rationale: '完成任务', action: { type: 'finish', answer: '最终结果' }, readonly: true },
];

export function buildNvidiaActionExampleLines({
  ideEnabled = false,
  chromeEnabled = false,
  mcpEnabled = false,
  readonly = false,
  includeToolNames,
}: {
  ideEnabled?: boolean;
  chromeEnabled?: boolean;
  mcpEnabled?: boolean;
  readonly?: boolean;
  includeToolNames?: Iterable<string>;
} = {}) {
  const allowed = includeToolNames ? new Set(includeToolNames) : null;
  return NVIDIA_ACTION_EXAMPLES
    .filter(example => !readonly || example.readonly)
    .filter(example => !allowed || allowed.has(String(example.action.type || '')))
    .filter(example => example.capability !== 'ide' || ideEnabled)
    .filter(example => example.capability !== 'chrome' || chromeEnabled)
    .filter(example => example.capability !== 'mcp' || mcpEnabled)
    .map(({ rationale, action }) => JSON.stringify({ rationale, action }));
}

function buildNvidiaToolSignatureLines(toolNames: Iterable<string>) {
  const names = new Set(toolNames);
  const hasAny = (items: string[]) => items.some(name => names.has(name));
  return [
    hasAny(WEB_TOOL_NAMES) ? 'browser: navigate(url), click(elementId), type(elementId,text), wait(seconds), scroll(direction,amount), get_page_content(), http_fetch(url,extractLinks?)' : '',
    hasAny(FILE_TOOL_NAMES) ? 'fs: list_dir(path), get_file_info(path), read_file(path), write_file(path,content,append), search_files(query,path,include?)；codegraph: codegraph_query(query)' : '',
    hasAny(TERMINAL_TOOL_NAMES) ? 'terminal: run_safe(command), run_confirmed(command), run_review(command)' : '',
    names.has('web_search') ? 'search: web_search(query,maxResults?)' : '',
    names.has('image_analyze') ? 'vision: image_analyze(image,question)' : '',
    hasAny(IDE_TOOL_NAMES) ? 'ide: ide_list_tools(refresh?), ide_call_tool(toolName,arguments)' : '',
    hasAny(CHROME_TOOL_NAMES) ? 'chrome: chrome_list_tools(refresh?), chrome_call_tool(toolName,arguments,refreshTools?)' : '',
    hasAny(MCP_TOOL_NAMES) ? 'mcp: mcp_list_servers(), mcp_list_tools(serverName,refresh?), mcp_call_tool(serverName,toolName,arguments,refreshTools?)' : '',
    'core: ask_user(question), notify_user(message,level), finish(answer)',
  ].filter(Boolean);
}

function historyUsesTool(history: any[] | undefined, tool: string) {
  return Array.isArray(history) && history.some(entry => entry?.action?.tool === tool);
}

function capabilityText(context: PromptCapabilityContext) {
  const task = context.task || '';
  const conversation = FOLLOWUP_TASK_RE.test(task)
    ? sanitizeConversationHistory(context.conversationHistory).slice(-8).map(message => message.content).join('\n')
    : '';
  return `${task}\n${conversation}`;
}

function addToolGroup(target: Set<string>, names: string[]) {
  for (const name of names) target.add(name);
}

function comparableConversationText(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function sanitizeConversationHistory(value: PromptCapabilityContext['conversationHistory']) {
  if (!Array.isArray(value)) return [];
  const sanitized: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const rejectedEchoes = new Set<string>();

  for (const message of value.slice(-10)) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) continue;
    const comparable = comparableConversationText(content);

    if (message.role === 'assistant') {
      if (rejectedEchoes.has(comparable)) continue;
      const previous = sanitized.at(-1);
      if (previous?.role === 'user' && comparable && comparable === comparableConversationText(previous.content)) {
        sanitized.pop();
        rejectedEchoes.add(comparable);
        continue;
      }
      if (previous?.role === 'assistant' && comparable === comparableConversationText(previous.content)) continue;
    }

    sanitized.push({ role: message.role, content });
  }

  return sanitized;
}

export function selectGeminiToolNames(context: PromptCapabilityContext = {}) {
  const selected = new Set(CORE_TOOL_NAMES);
  const text = capabilityText(context);
  const history = Array.isArray(context.history) ? context.history : [];
  const usedTools = new Set(history.map(entry => entry?.action?.tool).filter(Boolean));
  const browserObserved = Boolean(
    context.observation?.browser
    || context.observation?.url
    || context.observation?.elements?.length
  );

  const needsChrome = shouldIncludeChromePromptDetails(context);
  const needsIde = shouldIncludeIdePromptDetails(context);
  const needsMcp = shouldIncludeGenericMcpDetails(context);
  const needsWeb = WEB_TASK_RE.test(text)
    || browserObserved
    || needsChrome
    || usedTools.has('browser')
    || usedTools.has('search')
    || usedTools.has('chrome');
  const needsFiles = FILE_TASK_RE.test(text)
    || needsIde
    || usedTools.has('fs')
    || usedTools.has('codegraph')
    || usedTools.has('ide');
  const needsTerminal = TERMINAL_TASK_RE.test(text) || usedTools.has('terminal');
  const needsVision = VISION_TASK_RE.test(text) || usedTools.has('vision');

  if (needsWeb) addToolGroup(selected, WEB_TOOL_NAMES);
  if (needsFiles) addToolGroup(selected, FILE_TOOL_NAMES);
  if (needsTerminal) addToolGroup(selected, TERMINAL_TOOL_NAMES);
  if (needsVision) addToolGroup(selected, VISION_TOOL_NAMES);
  if (needsIde) addToolGroup(selected, IDE_TOOL_NAMES);
  if (needsChrome) addToolGroup(selected, CHROME_TOOL_NAMES);
  if (needsMcp) addToolGroup(selected, MCP_TOOL_NAMES);
  return selected;
}

function historyShowsBrowserBlock(history: any[] | undefined) {
  if (!Array.isArray(history)) return false;
  return history.some(entry => (
    entry?.action?.tool === 'browser'
    && BROWSER_BLOCK_RE.test(String(entry?.result || ''))
  ));
}

export function shouldIncludeChromePromptDetails({ task = '', history = [], observation }: PromptCapabilityContext = {}) {
  return CHROME_TASK_RE.test(task)
    || historyUsesTool(history, 'chrome')
    || historyShowsBrowserBlock(history)
    || BROWSER_BLOCK_RE.test(String(observation?.browser?.text || ''));
}

export function shouldIncludeIdePromptDetails({ task = '', history = [] }: PromptCapabilityContext = {}) {
  return IDE_TASK_RE.test(task) || historyUsesTool(history, 'ide');
}

export function shouldIncludeGenericMcpDetails({ task = '', history = [] }: PromptCapabilityContext = {}) {
  return isGenericMcpEnabled() && (GENERIC_MCP_TASK_RE.test(task) || historyUsesTool(history, 'mcp'));
}

function genericMcpPromptLines(context: PromptCapabilityContext) {
  if (!isGenericMcpEnabled()) return [];
  const names = listGenericMcpServers().map(server => server.name).join(', ');
  if (shouldIncludeGenericMcpDetails(context)) {
    return [`通用 MCP 已启用（${names}）。先调用 mcp_list_servers / mcp_list_tools 发现能力，再用 mcp_call_tool 调用；所有通用工具调用默认需要用户确认。`];
  }
  if (context.includeInactiveCapabilityHints === false) return [];
  return [`通用 MCP server 已启用（${names}），仅在任务明确要求 MCP、Codex 或外部专家能力时使用。`];
}

function chromePromptLines(context: PromptCapabilityContext) {
  if (!isChromeMcpAvailable()) return [];
  if (shouldIncludeChromePromptDetails(context)) return buildChromePromptLines();
  if (context.includeInactiveCapabilityHints === false) return [];
  return [
    'Chrome MCP 已启用但默认不展开。仅当任务明确要求 Chrome/DevTools，或内置浏览器遭遇 CAPTCHA、403、Cloudflare 等拦截时，调用 {"tool":"chrome","type":"chrome_list_tools"} 按需获取工具。',
  ];
}

function idePromptLines(context: PromptCapabilityContext) {
  if (!isIdeMcpEnabled()) return [];
  if (shouldIncludeIdePromptDetails(context)) return buildIdePromptLines();
  if (context.includeInactiveCapabilityHints === false) return [];
  return [
    'IDE MCP 已启用但默认不展开。仅当任务明确需要 JetBrains/IDE 能力时，调用 {"tool":"ide","type":"ide_list_tools"} 按需获取工具。',
  ];
}

// 提取最近 N 步 browser/chrome 工具访问过的 URL，提示模型避免原地踏步。
// trace 中曾出现同一 URL 被模型连续访问 3 次的情况，仅靠 history 推理不足以让模型察觉。
function buildRecentUrlsHint(history: any[], lookback = 5): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const recent = history.slice(-lookback);
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const entry of recent) {
    const action = entry?.action || {};
    const tool = action.tool || '';
    if (tool !== 'browser' && tool !== 'chrome') continue;
    let url: string | undefined;
    if (typeof action.url === 'string') url = action.url;
    else if (action.arguments && typeof action.arguments.url === 'string') url = action.arguments.url;
    if (!url) continue;
    if (!counts.has(url)) order.push(url);
    counts.set(url, (counts.get(url) || 0) + 1);
  }
  if (order.length === 0) return null;
  const lines = order.map(url => {
    const n = counts.get(url) || 1;
    const flag = n >= 2 ? '【已访问 ' + n + ' 次，避免重复】' : '';
    return `- ${url} ${flag}`.trim();
  });
  return `最近访问过的 URL（避免重复访问相同页面，除非有明确新目的）：\n${lines.join('\n')}`;
}

function searchResultFailed(entry: any) {
  const status = typeof entry?.resultStatus === 'string'
    ? entry.resultStatus.trim().toLowerCase()
    : '';
  const result = String(entry?.result ?? '').trim();
  return status === 'failed' || /^web_search\s+失败/.test(result);
}

function buildRecentSearchesHint(history: any[], lookback = 6): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const recent = history.slice(-lookback);
  const counts = new Map<string, { count: number; failed: number }>();
  const order: string[] = [];

  for (const entry of recent) {
    const action = entry?.action || {};
    if (action.tool !== 'search' || action.type !== 'web_search') continue;
    const query = typeof action.query === 'string' ? action.query.trim() : '';
    if (!query) continue;
    if (!counts.has(query)) {
      order.push(query);
      counts.set(query, { count: 0, failed: 0 });
    }
    const item = counts.get(query)!;
    item.count += 1;
    if (searchResultFailed(entry)) item.failed += 1;
  }

  const lines = order
    .map(query => ({ query, stats: counts.get(query)! }))
    .filter(({ stats }) => stats.count >= 2 || stats.failed > 0)
    .map(({ query, stats }) => {
      const markers = [];
      if (stats.count >= 2) markers.push(`已搜索 ${stats.count} 次`);
      if (stats.failed > 0) markers.push(`失败 ${stats.failed} 次`);
      return `- "${query}" ${markers.join('，')}【不要原样重复，换关键词、换来源或停止说明限制】`;
    });

  if (lines.length === 0) return null;
  return `最近搜索过的 query（避免在失败或重复后原样重试）：\n${lines.join('\n')}`;
}

function promptResultText(value: any) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function buildCurrentDateTimeContext(now = new Date()) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now).map(part => [part.type, part.value]),
  );
  const localDateTime = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  return {
    localDateTime,
    timeZone,
    iso: now.toISOString(),
  };
}

export function compactAgentHistory(history: any[], maxEntries?: number, maxResultChars?: number, task = '') {
  if (!Array.isArray(history) || history.length === 0) return [];
  const config = configStore.get();
  const entryLimit = maxEntries ?? config.maxHistorySteps;
  const resultLimit = maxResultChars ?? config.maxResultChars;
  return history.slice(-entryLimit).map(entry => {
    const result = promptResultText(entry?.result);
    return {
      step: entry?.step,
      rationale: entry?.rationale,
      action: entry?.action,
      result: compactToolResult({ result, action: entry?.action, task, limit: resultLimit }),
      ...(entry?.resultStatus ? { resultStatus: entry.resultStatus } : {}),
    };
  });
}

function buildSharedAgentRuleLines(capabilityContext: PromptCapabilityContext = {}) {
  const ideLines = idePromptLines(capabilityContext);
  const chromeDetails = shouldIncludeChromePromptDetails(capabilityContext);
  const chromeLines = chromePromptLines(capabilityContext);
  const mcpLines = genericMcpPromptLines(capabilityContext);
  const webDetails = WEB_TASK_RE.test(capabilityText(capabilityContext))
    || historyUsesTool(capabilityContext.history, 'search')
    || historyUsesTool(capabilityContext.history, 'browser');
  return [
    '规则：',
    '1. task 是本轮唯一目标；conversationHistory 只用于理解指代，不得恢复或切换到旧任务。',
    '2. 决策顺序：已有信息足够则立即 finish；缺少用户才能决定的信息则 ask_user；否则选择完成目标所需的最少工具。不要为了显得在执行而探索。',
    '3. 不要重复已成功或无新目的的动作。同一目标连续约 5 步仍无实质进展时停止尝试，finish 汇总已知信息并说明限制。',
    '4. 文件写入和终端确认命令可能需要审批；cd/pushd/popd 使用 run_review。被拒绝后改用安全替代方案。',
    '5. browser.click/type 只能使用 observation.browser.elements 中存在的 elementId；不要 navigate 到搜索引擎结果页。',
    '6. 不得编造工具结果；未核验或未取得目标网页正文时必须明确说明。',
    ...(webDetails ? ['网络任务：web_search 只用于发现来源，不得仅凭标题或摘要回答需核验的问题。选择最相关的 1～3 个官方、原始或权威 URL，逐个 http_fetch 正文，只提取与问题直接相关的事实、数字、时间和条件，并保留来源对应关系。正文无明确答案时说明未找到，不得用常识补全；来源冲突时分别列出，不要自行合并。'] : []),
    '7. 图片任务必须使用 image_analyze，不得凭文件名猜测。任务含 [附件]/[Attachments] 图片时，image 使用 @attachment/N（按图片出现顺序从 1 开始），不得复制或改写 @uploads 路径；runtime 会绑定真实附件。简单识图得到可用结果后立即 finish；同一图片最多连续分析 2 次，无法确认具体来源时区分可见事实与低置信猜测。',
    '8. 酒店、机票、电商等实时价格优先用 web_search 获取区间；拿不到精确数字时给出查询入口并说明未取得实时精确价。',
    '9. 重要发现可用 notify_user。finish 的 answer 使用简体中文，简洁直接。',
    '每步输入中的 currentDateTime 是当前日期时间；涉及“今天”“最新”“近期”等相对时间时必须以它为准，不得猜测年份。',
    ...(chromeDetails ? ['10. 内置浏览器被 CAPTCHA、403 或 Cloudflare 拦截时，改用 Chrome MCP 访问同一目标。'] : []),
    ...ideLines,
    ...chromeLines,
    ...mcpLines,
  ];
}

function buildReadonlyAgentRuleLines(systemPrompt: string | null) {
  return [
    '你处于只读分析模式，只负责分析并返回结果。',
    '每步输入中的 currentDateTime 是当前日期时间；涉及相对时间时必须以它为准，不得猜测年份。',
    '禁止写文件、运行终端、操作浏览器/Chrome/IDE、询问或通知用户。',
    '路径必须使用项目内相对路径。完成后立即调用 finish 返回简洁结果。',
    systemPrompt ? `附加约束：${systemPrompt}` : '',
  ].filter(Boolean);
}

export function buildDesktopAgentSystemPrompt(
  systemPrompt: string | null,
  toolMode: 'full' | 'readonly' = 'full',
  capabilityContext: PromptCapabilityContext = {},
) {
  if (toolMode === 'readonly') {
    return [
      '只能使用当前提供的只读工具。',
      ...buildReadonlyAgentRuleLines(systemPrompt),
    ].filter(Boolean).join('\n');
  }
  return [
    '你是 DesktopAgent，负责在浏览器、文件系统、终端、IDE 和 MCP 工具之间协同完成任务。',
    '每个步骤必须调用且只能调用一个当前提供的工具；任务完成时调用 finish。',
    ...buildSharedAgentRuleLines(capabilityContext),
    systemPrompt ? `附加约束：${systemPrompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Gemini 决策消息：把 task/step/history/observation 这坨 JSON 塞进一个
// user part，system 由 provider 单独传。
export function buildGeminiTaskMessages({
  task,
  step,
  history,
  observation,
  conversationHistory,
}: {
  task: string;
  step: number;
  history: any[];
  observation: any;
  conversationHistory?: Array<{ role: string; content: string }>;
}) {
  const contents: any[] = [];
  const sanitizedConversation = sanitizeConversationHistory(conversationHistory);
  if (sanitizedConversation.length) {
    for (const msg of sanitizedConversation) {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    }
  }
  const recentUrlsHint = buildRecentUrlsHint(history);
  const recentSearchesHint = buildRecentSearchesHint(history);
  const promptHistory = compactAgentHistory(history, undefined, undefined, task);
  const currentDateTime = buildCurrentDateTimeContext();
  contents.push({
    role: 'user',
    parts: [{ text: JSON.stringify({ task, currentDateTime, step, history: promptHistory, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}), ...(recentSearchesHint ? { recentSearchesHint } : {}) }) }],
  });
  return { contents };
}

export function buildGeminiAgentPromptPayload(
  context: any,
  toolMode: 'full' | 'readonly' = 'full',
) {
  const capabilityContext = { ...context, includeInactiveCapabilityHints: false };
  const systemInstruction = buildDesktopAgentSystemPrompt(
    context.systemPrompt || '',
    toolMode,
    capabilityContext,
  );
  const { contents } = buildGeminiTaskMessages(context);
  const includeToolNames = toolMode === 'readonly' ? undefined : selectGeminiToolNames(context);
  const tools = [{
    functionDeclarations: createModelTools({
      mode: toolMode,
      includeChromeMcp: shouldIncludeChromePromptDetails(context),
      includeIdeMcp: shouldIncludeIdePromptDetails(context),
      includeGenericMcp: shouldIncludeGenericMcpDetails(context),
      includeToolNames,
    }).map(toolToGeminiTool),
  }];
  return {
    systemInstruction,
    contents,
    tools,
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
  };
}

export function buildNvidiaTaskMessages({
  task,
  systemPrompt,
  step,
  history,
  observation,
  conversationHistory,
  compact = false,
  toolMode = 'full',
}: {
  task: string;
  systemPrompt?: string | null;
  step: number;
  history: any[];
  observation: any;
  conversationHistory?: Array<{ role: string; content: string }>;
  compact?: boolean;
  toolMode?: 'full' | 'readonly';
}) {
  const capabilityContext = { task, history, observation, conversationHistory };
  const ideEnabled = isIdeMcpEnabled();
  const ideDetails = shouldIncludeIdePromptDetails(capabilityContext);
  const chromeEnabled = isChromeMcpAvailable();
  const chromeDetails = shouldIncludeChromePromptDetails(capabilityContext);
  const mcpEnabled = isGenericMcpEnabled();
  const mcpDetails = shouldIncludeGenericMcpDetails(capabilityContext);
  const sanitizedConversation = sanitizeConversationHistory(conversationHistory);
  const conversationSummary = sanitizedConversation.length
    ? '\n\n之前的对话（仅用于理解当前 task 的指代，不得继续旧任务）：\n' + sanitizedConversation
        .map(message => `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`)
        .join('\n')
    : '';

  const recentUrlsHint = buildRecentUrlsHint(history);
  const recentSearchesHint = buildRecentSearchesHint(history);
  const promptHistory = compactAgentHistory(history, undefined, undefined, task);
  const selectedToolNames = selectGeminiToolNames(capabilityContext);
  const currentDateTime = buildCurrentDateTimeContext();

  if (toolMode === 'readonly') {
    return [
      {
        role: 'system',
        content: [
          '每个步骤必须且只能输出一个 JSON 对象。',
          '可用动作只有：fs list_dir/read_file/get_file_info/search_files；search web_search；vision image_analyze；codegraph codegraph_query；core finish。',
          '可用动作示例（字段名和层级必须严格照此填写）：',
          ...buildNvidiaActionExampleLines({ readonly: true }),
          ...buildReadonlyAgentRuleLines(systemPrompt || null),
        ].filter(Boolean).join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ task, currentDateTime, step, history: compactAgentHistory(history, compact ? 2 : 6, undefined, task), observation }),
      },
    ];
  }

  if (compact) {
    return [
      {
        role: 'system',
        content: [
          '你是 DesktopAgent。只能输出一个 JSON 对象。',
          '若可直接回答，必须输出 {"rationale":"...","action":{"type":"finish","answer":"..."}}，不要使用 type:"answer"。',
          '若需工具，action.tool/type 只能使用：browser navigate/click/get_page_content/http_fetch；fs list_dir/read_file/search_files；terminal run_safe；search web_search；vision image_analyze；core ask_user/notify_user。',
          'web_search 只用于发现候选来源；需要事实核验时不得仅凭摘要回答，必须选择相关权威 URL 调用 http_fetch，阅读正文后提取事实、数字、时间和条件，并说明来源。正文没有明确答案时必须说明未找到，不得猜测。',
          '任务含图片附件时，image_analyze.image 使用 @attachment/N（按图片出现顺序从 1 开始），不要复制或改写 @uploads 路径。',
          '常识问答、闲聊、解释类任务必须直接 finish，不要调用工具。',
          '每步输入中的 currentDateTime 是当前日期时间；涉及相对时间时必须以它为准，不得猜测年份。',
          'answer 用简体中文，简洁直接。',
          systemPrompt ? `附加约束：${systemPrompt}` : '',
        ].filter(Boolean).join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ task, currentDateTime, step, history: compactAgentHistory(history, 2, 1500, task), observation }),
      },
    ];
  }

  return [
    {
      role: 'system',
      content: [
        '你是 DesktopAgent，负责在浏览器、文件系统、终端、IDE 和 MCP 工具之间协同完成任务。',
        '你只能输出一个 JSON 对象，不要输出 Markdown，不要解释。',
        '输出格式固定为 {"rationale":"简短理由","action":{...}}。',
        '可用动作示例（字段名、字段层级、tool 和 type 必须严格照此填写；每一步只输出其中一个 JSON 对象）：',
        ...buildNvidiaActionExampleLines({
          ideEnabled,
          chromeEnabled,
          mcpEnabled: mcpEnabled && mcpDetails,
          includeToolNames: selectedToolNames,
        }),
        '可用动作签名（括号内为主要参数）：',
        ...buildNvidiaToolSignatureLines(selectedToolNames),
        '重要：每个步骤必须且只能输出一个 JSON 动作。如果你已经收集到足够信息并可以直接回答用户问题，请使用 finish 动作输出答案。绝对不要在 JSON 之外输出解释文字。',
        ...buildSharedAgentRuleLines(capabilityContext),
        systemPrompt ? `附加约束：${systemPrompt}` : '',
        conversationSummary,
      ]
        .filter(Boolean)
        .join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({ task, currentDateTime, step, history: promptHistory, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}), ...(recentSearchesHint ? { recentSearchesHint } : {}) }),
    },
  ];
}
