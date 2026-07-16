import { buildChromePromptLines, isChromeMcpAvailable } from '../tools/chrome/mcp-client.ts';
import { isGenericMcpEnabled, listGenericMcpServers } from '../tools/mcp/client.ts';
import { configStore } from './config-store.ts';
import { inferTool } from './action-types.ts';
import { createModelTools, toolToGeminiTool, type ModelToolDefinition } from './tool-definitions.ts';
import { compactToolResult } from './result-extraction.ts';

type PromptCapabilityContext = {
  task?: string;
  history?: any[];
  observation?: any;
  conversationHistory?: Array<{ role?: string; content?: string }>;
  includeInactiveCapabilityHints?: boolean;
};

const CHROME_TASK_RE = /\bchrome\b|devtools|开发者工具|真实浏览器|网络面板|performance|lighthouse|控制台|console/i;
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
const CHROME_TOOL_NAMES = ['chrome_list_tools', 'chrome_call_tool'];
const MCP_TOOL_NAMES = ['mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool'];
const COMPACT_TOOL_NAMES = new Set([
  'navigate',
  'click',
  'get_page_content',
  'http_fetch',
  'list_dir',
  'read_file',
  'search_files',
  'run_safe',
  'web_search',
  'image_analyze',
  'ask_user',
  'notify_user',
  'finish',
]);

type PromptToolOptions = {
  chromeEnabled?: boolean;
  mcpEnabled?: boolean;
  includeToolNames?: Iterable<string>;
};

function selectPromptToolDefinitions({
  chromeEnabled = false,
  mcpEnabled = false,
  includeToolNames,
}: PromptToolOptions = {}) {
  return createModelTools({
    includeChromeMcp: chromeEnabled,
    includeGenericMcp: mcpEnabled,
    includeToolNames,
  });
}

function actionExampleForTool(definition: ModelToolDefinition) {
  const owner = inferTool(definition.name);
  if (!owner) throw new Error(`工具 ${definition.name} 缺少 action tool 映射`);
  return {
    rationale: definition.example.rationale,
    action: {
      tool: owner,
      type: definition.name,
      ...definition.example.input,
    },
  };
}

function buildNvidiaActionExampleLinesFromDefinitions(definitions: ModelToolDefinition[]) {
  return definitions.map(definition => JSON.stringify(actionExampleForTool(definition)));
}

export function buildNvidiaActionExampleLines(options: PromptToolOptions = {}) {
  return buildNvidiaActionExampleLinesFromDefinitions(selectPromptToolDefinitions(options));
}

const TOOL_SIGNATURE_GROUP_ORDER = ['browser', 'fs', 'terminal', 'search', 'vision', 'codegraph', 'chrome', 'mcp', 'core'];
const REPRESENTATIVE_ACTION_BY_TOOL: Record<string, string> = {
  browser: 'http_fetch',
  fs: 'read_file',
  terminal: 'run_safe',
  search: 'web_search',
  vision: 'image_analyze',
  codegraph: 'codegraph_query',
  chrome: 'chrome_list_tools',
  mcp: 'mcp_list_servers',
  core: 'finish',
};

function selectRepresentativeExampleDefinitions(definitions: ModelToolDefinition[]) {
  const groups = new Map<string, ModelToolDefinition[]>();
  for (const definition of definitions) {
    const owner = inferTool(definition.name);
    if (!owner) throw new Error(`工具 ${definition.name} 缺少 action tool 映射`);
    const group = groups.get(owner) || [];
    group.push(definition);
    groups.set(owner, group);
  }
  return TOOL_SIGNATURE_GROUP_ORDER.flatMap(owner => {
    const group = groups.get(owner);
    if (!group?.length) return [];
    const preferred = REPRESENTATIVE_ACTION_BY_TOOL[owner];
    return [group.find(definition => definition.name === preferred) || group[0]];
  });
}

function buildNvidiaToolSignatureLines(definitions: ModelToolDefinition[]) {
  const groups = new Map<string, string[]>();
  for (const definition of definitions) {
    const owner = inferTool(definition.name);
    if (!owner) throw new Error(`工具 ${definition.name} 缺少 action tool 映射`);
    const required = new Set(definition.input_schema.required || []);
    const parameters = Object.keys(definition.input_schema.properties)
      .map(name => required.has(name) ? name : `${name}?`)
      .join(',');
    const signatures = groups.get(owner) || [];
    signatures.push(`${definition.name}(${parameters})`);
    groups.set(owner, signatures);
  }
  return TOOL_SIGNATURE_GROUP_ORDER
    .filter(owner => groups.has(owner))
    .map(owner => `${owner}: ${groups.get(owner)!.join(', ')}`);
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
  const needsMcp = shouldIncludeGenericMcpDetails(context);
  const needsWeb = WEB_TASK_RE.test(text)
    || browserObserved
    || needsChrome
    || usedTools.has('browser')
    || usedTools.has('search')
    || usedTools.has('chrome');
  const needsFiles = FILE_TASK_RE.test(text)
    || usedTools.has('fs')
    || usedTools.has('codegraph');
  const needsTerminal = TERMINAL_TASK_RE.test(text) || usedTools.has('terminal');
  const needsVision = VISION_TASK_RE.test(text) || usedTools.has('vision');

  if (needsWeb) addToolGroup(selected, WEB_TOOL_NAMES);
  if (needsFiles) addToolGroup(selected, FILE_TOOL_NAMES);
  if (needsTerminal) addToolGroup(selected, TERMINAL_TOOL_NAMES);
  if (needsVision) addToolGroup(selected, VISION_TOOL_NAMES);
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

function hasAnyTool(toolNames: Set<string>, candidates: string[]) {
  return candidates.some(name => toolNames.has(name));
}

function buildSharedAgentRuleLines(
  capabilityContext: PromptCapabilityContext = {},
  enabledToolNames: Iterable<string> = selectGeminiToolNames(capabilityContext),
) {
  const toolNames = new Set(enabledToolNames);
  const browserEnabled = hasAnyTool(toolNames, WEB_TOOL_NAMES.filter(name => name !== 'web_search'));
  const approvalToolsEnabled = toolNames.has('write_file')
    || toolNames.has('run_confirmed')
    || toolNames.has('run_review');
  const visionEnabled = toolNames.has('image_analyze');
  const chromeEnabled = hasAnyTool(toolNames, CHROME_TOOL_NAMES);
  const mcpEnabled = hasAnyTool(toolNames, MCP_TOOL_NAMES);
  const chromeDetails = shouldIncludeChromePromptDetails(capabilityContext);
  const chromeLines = chromeEnabled ? chromePromptLines(capabilityContext) : [];
  const mcpLines = mcpEnabled ? genericMcpPromptLines(capabilityContext) : [];
  const webDetails = WEB_TASK_RE.test(capabilityText(capabilityContext))
    || historyUsesTool(capabilityContext.history, 'search')
    || historyUsesTool(capabilityContext.history, 'browser');
  return [
    '规则：',
    '- task 是本轮唯一目标；conversationHistory 只用于理解指代，不得恢复或切换到旧任务。',
    '- 已有信息足够则立即 finish；缺少用户才能决定的信息则 ask_user；否则选择完成目标所需的最少工具。不要为了显得在执行而探索。',
    '- 不要重复已成功或无新目的的动作。同一目标连续约 5 步仍无实质进展时停止尝试，finish 汇总已知信息并说明限制。',
    '- 不得编造工具结果。',
    ...(approvalToolsEnabled ? ['- 文件写入和终端确认命令可能需要审批；cd/pushd/popd 使用 run_review。被拒绝后改用安全替代方案。'] : []),
    ...(browserEnabled ? ['- browser.click/type 只能使用 observation.browser.elements 中存在的 elementId；不要 navigate 到搜索引擎结果页。scroll 返回内容未变化后，不得继续滚动，改用 get_page_content、http_fetch 或 finish。'] : []),
    ...(webDetails ? ['- 网络任务中，web_search 只用于发现来源；拿到候选 URL 后优先用 http_fetch 提取正文，不要先 navigate。不得仅凭标题或摘要回答需核验的问题。选择最相关的 1～3 个官方、原始或权威 URL，逐个核验正文，只提取与问题直接相关的事实、数字、时间和条件，并保留来源对应关系。正文无明确答案时说明未找到，不得用常识补全；来源冲突时分别列出。'] : []),
    ...(visionEnabled ? ['- 图片任务必须使用 image_analyze，不得凭文件名猜测。附件图片使用 @attachment/N（按出现顺序从 1 开始），不得复制或改写 @uploads 路径。简单识图得到结果后立即 finish；同一图片最多连续分析 2 次，证据不足时区分可见事实与低置信猜测。'] : []),
    ...(webDetails ? ['- 酒店、机票、电商等实时价格优先用 web_search 获取区间；拿不到精确数字时给出查询入口并说明未取得实时精确价。'] : []),
    '- 重要发现可用 notify_user。finish 的 answer 使用简体中文，简洁直接。',
    '- currentDateTime 是当前日期时间；涉及“今天”“最新”“近期”等相对时间时必须以它为准，不得猜测年份。',
    ...(chromeEnabled && chromeDetails ? ['- 内置浏览器被 CAPTCHA、403 或 Cloudflare 拦截时，改用 Chrome MCP 访问同一目标。'] : []),
    ...chromeLines,
    ...mcpLines,
  ];
}

function buildCompactAgentRuleLines(
  capabilityContext: PromptCapabilityContext,
  definitions: ModelToolDefinition[],
) {
  const toolNames = new Set(definitions.map(definition => definition.name));
  const webDetails = WEB_TASK_RE.test(capabilityText(capabilityContext))
    || historyUsesTool(capabilityContext.history, 'search')
    || historyUsesTool(capabilityContext.history, 'browser');
  return [
    '规则：',
    '- task 是本轮唯一目标；已有信息足够则立即 finish，缺少关键选择时才 ask_user。',
    '- 只选择完成目标所需的最少动作，不得编造工具结果或重复无进展的动作。',
    ...(hasAnyTool(toolNames, ['click']) ? ['- click 只能使用 observation.browser.elements 中存在的 elementId；scroll 返回内容未变化后改用 get_page_content、http_fetch 或 finish。'] : []),
    ...(webDetails && toolNames.has('web_search') && toolNames.has('http_fetch') ? ['- web_search 只用于发现来源；需要事实核验时必须 http_fetch 权威正文，不得仅凭摘要回答。'] : []),
    ...(toolNames.has('image_analyze') ? ['- 附件图片使用 @attachment/N，不得复制或改写 @uploads 路径。'] : []),
    '- currentDateTime 是当前日期时间；涉及相对时间时以它为准，不得猜测年份。finish.answer 使用简体中文，简洁直接。',
  ];
}

export function buildDesktopAgentSystemPrompt(
  systemPrompt: string | null,
  capabilityContext: PromptCapabilityContext = {},
  enabledToolNames?: Iterable<string>,
) {
  return [
    '你是 DesktopAgent，负责在浏览器、文件系统、终端和 MCP 工具之间协同完成任务。',
    '每个步骤必须调用且只能调用一个当前提供的工具；任务完成时调用 finish。',
    ...buildSharedAgentRuleLines(capabilityContext, enabledToolNames),
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

export function buildGeminiAgentPromptPayload(context: any) {
  const capabilityContext = { ...context, includeInactiveCapabilityHints: false };
  const includeToolNames = context.finalOnly
    ? new Set(['finish'])
    : selectGeminiToolNames(context);
  const systemInstruction = context.finalOnly
    ? [
        '你是 DesktopAgent 的最终总结器。工具执行步数已经耗尽。',
        '只能调用 finish，根据 task 和 history 中已经取得的结果给出最终答案。不得调用其他工具，不得忽略已成功获取的信息。',
        'finish.answer 使用简体中文，明确区分已核验事实、失败步骤和仍缺失的信息。',
        context.systemPrompt ? `附加约束：${context.systemPrompt}` : '',
      ].filter(Boolean).join('\n')
    : buildDesktopAgentSystemPrompt(
        context.systemPrompt || '',
        capabilityContext,
        includeToolNames,
      );
  const { contents } = buildGeminiTaskMessages(context);
  const tools = [{
    functionDeclarations: createModelTools({
      includeChromeMcp: shouldIncludeChromePromptDetails(context),
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
  finalOnly = false,
}: {
  task: string;
  systemPrompt?: string | null;
  step: number;
  history: any[];
  observation: any;
  conversationHistory?: Array<{ role: string; content: string }>;
  compact?: boolean;
  finalOnly?: boolean;
}) {
  const capabilityContext = { task, history, observation, conversationHistory, includeInactiveCapabilityHints: false };
  const chromeEnabled = isChromeMcpAvailable();
  const chromeDetails = shouldIncludeChromePromptDetails(capabilityContext);
  const mcpEnabled = isGenericMcpEnabled();
  const mcpDetails = shouldIncludeGenericMcpDetails(capabilityContext);
  const sanitizedConversation = sanitizeConversationHistory(conversationHistory);
  const conversationSummary = sanitizedConversation.length
    ? [
        '之前的对话（仅用于理解当前 task 的指代，不得继续旧任务）：',
        ...sanitizedConversation.map(message => `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`),
      ].join('\n')
    : '';

  const recentUrlsHint = buildRecentUrlsHint(history);
  const recentSearchesHint = buildRecentSearchesHint(history);
  const promptHistory = compactAgentHistory(history, undefined, undefined, task);
  const selectedToolNames = selectGeminiToolNames(capabilityContext);
  const currentDateTime = buildCurrentDateTimeContext();

  if (finalOnly) {
    return [
      {
        role: 'system',
        content: [
          '你是 DesktopAgent 的最终总结器。工具执行步数已经耗尽。',
          '只能输出一个合法 JSON 对象，不要输出其他文字。',
          '必须根据 task 和 history 中已经取得的结果完成回答，不得调用其他工具，不得忽略已成功获取的信息。',
          '固定格式：{"rationale":"总结已有结果","action":{"tool":"core","type":"finish","answer":"最终答案"}}。',
          'answer 使用简体中文，明确区分已核验事实、失败步骤和仍缺失的信息。',
          systemPrompt ? `附加约束：${systemPrompt}` : '',
        ].filter(Boolean).join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ task, currentDateTime, step, history: promptHistory, observation }),
      },
    ];
  }

  if (compact) {
    const compactToolNames = [...selectedToolNames].filter(name => COMPACT_TOOL_NAMES.has(name));
    const compactToolDefinitions = selectPromptToolDefinitions({ includeToolNames: compactToolNames });
    return [
      {
        role: 'system',
        content: [
          '你是 DesktopAgent。每个步骤必须且只能输出一个合法 JSON 对象，不要输出其他文字。',
          '固定结构：{"rationale":"一句话理由","action":{"tool":"工具名","type":"动作类型",...}}。',
          '完成任务：{"rationale":"任务已经完成","action":{"tool":"core","type":"finish","answer":"最终结果"}}。',
          '可用动作签名：',
          ...buildNvidiaToolSignatureLines(compactToolDefinitions),
          ...buildCompactAgentRuleLines(capabilityContext, compactToolDefinitions),
          systemPrompt ? `附加约束：${systemPrompt}` : '',
        ].filter(Boolean).join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ task, currentDateTime, step, history: compactAgentHistory(history, 2, 1500, task), observation }),
      },
    ];
  }

  const promptToolDefinitions = selectPromptToolDefinitions({
    chromeEnabled,
    mcpEnabled: mcpEnabled && mcpDetails,
    includeToolNames: selectedToolNames,
  });

  return [
    {
      role: 'system',
      content: [
        '你是 DesktopAgent，负责在浏览器、文件系统、终端和 MCP 工具之间协同完成任务。',
        '输出协议：',
        '1. 每个步骤必须且只能输出一个合法的 JSON 对象；禁止输出 Markdown、代码块、注释、解释或其他文字。',
        '2. JSON 使用双引号且无尾随逗号，固定顶层结构为 {"rationale":"一句话理由","action":{"tool":"工具名","type":"动作类型",...}}。',
        '3. rationale 只说明当前动作的直接目的，必须简短，不要输出详细推理过程。',
        '4. 每次只能选择一个已启用动作；action 必须严格遵循下方示例及签名，不得添加未定义字段。',
        '5. 每个 action 都必须包含 tool 和 type；finish 固定使用 {"tool":"core","type":"finish","answer":"最终结果"}。',
        '代表性动作示例：',
        ...buildNvidiaActionExampleLinesFromDefinitions(selectRepresentativeExampleDefinitions(promptToolDefinitions)),
        '可用动作签名（括号内为主要参数）：',
        ...buildNvidiaToolSignatureLines(promptToolDefinitions),
        ...buildSharedAgentRuleLines(capabilityContext, selectedToolNames),
        systemPrompt ? `附加约束：${systemPrompt}` : '',
        conversationSummary,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ task, currentDateTime, step, history: promptHistory, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}), ...(recentSearchesHint ? { recentSearchesHint } : {}) }),
    },
  ];
}
