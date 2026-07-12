import { buildIdePromptLines, isIdeMcpEnabled } from '../tools/ide/mcp-client.ts';
import { buildChromePromptLines, isChromeMcpAvailable } from '../tools/chrome/mcp-client.ts';
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
const BROWSER_BLOCK_RE = /captcha|cloudflare|403|forbidden|人机验证|反爬|访问受限|被拦截|blocked/i;
const WEB_TASK_RE = /https?:\/\/|\bwww\.|\bweb\b|browser|website|search|news|weather|price|flight|hotel|online|网页|浏览器|网站|上网|搜索|查询|新闻|天气|实时|价格|机票|航班|酒店|电商|官网/i;
const FILE_TASK_RE = /\b(project|repo|repository|code|source|file|folder|directory|path|config|dependency|readme)\b|项目|仓库|代码|源码|文件|文件夹|目录|路径|配置|依赖|模块|读取|写入|修改|编辑|创建|删除|重命名|查找|修复/i;
const TERMINAL_TASK_RE = /\b(shell|terminal|command|npm|pnpm|yarn|bun|git|curl|build|test|lint|install|process|server|log|pull|push|commit|merge|branch|checkout|deploy)\b|命令|终端|运行|执行|构建|测试|安装|启动|停止|服务|进程|日志|拉取|提交|推送|合并|分支|部署/i;
const MACOS_TASK_RE = /\b(mac(?:os)?|desktop|window|screen|keyboard|mouse|finder)\b|\b(?:open|launch|activate)\s+(?:the\s+)?app\b|桌面|窗口|屏幕|应用|软件|键盘|鼠标|点击坐标|按键|截屏|截个图/i;
const VISION_TASK_RE = /\[附件\]|\.(?:png|jpe?g|gif|webp|bmp|heic)(?:\b|\?)|\b(image|photo|picture|screenshot|ocr|vision)\b|图片|图像|照片|截图|识图|看图|图里|图中/i;
const SPAWN_TASK_RE = /\b(batch|parallel|multiple|each|compare)\b|批量|并行|同时|分别|多个|多份|每个|逐个|对比|比较/i;
const FOLLOWUP_TASK_RE = /^\s*(?:(?:继续|接着|重试|再试|这个|那个|上面|刚才|照旧)(?:\s|$)|(?:continue|retry|that|it)\b)/i;

// web_search 作为轻量信息查询兜底常驻，避免产品目录、模型上下线、版本变化等
// 时效性问题未命中关键词分类后只剩 finish，导致模型把问题原样返回。
const CORE_TOOL_NAMES = ['web_search', 'ask_user', 'notify_user', 'finish'];
const WEB_TOOL_NAMES = ['navigate', 'click', 'type', 'wait', 'scroll', 'get_page_content', 'http_fetch', 'parallel_fetch', 'web_search'];
const FILE_TOOL_NAMES = ['list_dir', 'read_file', 'get_file_info', 'write_file', 'search_files', 'codegraph_query'];
const TERMINAL_TOOL_NAMES = ['run_safe', 'run_confirmed', 'run_review'];
const MACOS_TOOL_NAMES = ['open_app', 'activate_app', 'list_windows', 'capture_screen', 'type_text', 'press_key', 'click_at'];
const VISION_TOOL_NAMES = ['image_analyze'];
const SPAWN_TOOL_NAMES = ['spawn'];
const IDE_TOOL_NAMES = ['ide_list_tools', 'ide_call_tool'];
const CHROME_TOOL_NAMES = ['chrome_list_tools', 'chrome_call_tool'];

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
  const needsMacos = MACOS_TASK_RE.test(text) || usedTools.has('macos');
  const needsVision = VISION_TASK_RE.test(text) || needsMacos || usedTools.has('vision');
  const needsSpawn = SPAWN_TASK_RE.test(text) || usedTools.has('spawn');

  if (needsWeb) addToolGroup(selected, WEB_TOOL_NAMES);
  if (needsFiles) addToolGroup(selected, FILE_TOOL_NAMES);
  if (needsTerminal) addToolGroup(selected, TERMINAL_TOOL_NAMES);
  if (needsMacos) addToolGroup(selected, MACOS_TOOL_NAMES);
  if (needsVision) addToolGroup(selected, VISION_TOOL_NAMES);
  if (needsSpawn) addToolGroup(selected, SPAWN_TOOL_NAMES);
  if (needsIde) addToolGroup(selected, IDE_TOOL_NAMES);
  if (needsChrome) addToolGroup(selected, CHROME_TOOL_NAMES);
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
  return [
    '规则：',
    '0. task 字段是本轮唯一执行目标，优先级高于 conversationHistory。历史对话只用于理解指代和上下文，禁止恢复、继续或切换到历史中的旧任务。',
    '0.1 涉及产品能力、模型目录、版本变化、供应商上下线等可能随时间变化的信息时，优先使用 web_search 核验，不要仅凭记忆回答。',
    '1. 只有 observation.browser.elements 中存在的 elementId 才能用于 browser.click / browser.type。',
    '2. 优先使用已知信息，不要重复无意义截图或重复读同一文件。任务一旦完成，必须立即调用 finish，绝不能重复执行已成功的动作。',
    '2.1 识别任务中的并行机会：当需要处理多个独立对象（多个文件、多个 URL、多个关键词）时，优先考虑用 spawn 并行处理而非串行逐个处理。',
    '2.2 若任务是常识问答、闲聊，或依据已有知识即可直接回答（无需读取文件/网页/桌面/终端），直接用 finish 返回答案，不要为了「显得在执行」而调用 list_dir、read_file 等探索性工具。',
    '3. 文件写入、终端确认命令、桌面键鼠输入可能需要用户批准，被拒绝后请尝试替代方案。',
    '4. cd/pushd/popd 等目录切换命令使用 run_review，会触发用户审批。',
    '5. answer 用简体中文，简洁直接。',
    '6. 需要全网搜索关键词时，优先使用 web_search（DuckDuckGo，返回标题/URL/摘要），再用 http_fetch 抓具体页面。禁止直接 navigate 到 Google/Bing/百度搜索结果页，这些页面容易触发反爬。',
    '7. http_fetch 和 navigate 都通过浏览器执行，可以处理需要 JS 渲染的页面。',
    '8. 需要同时获取多个页面时，使用 parallel_fetch 并发抓取（最多 5 个 URL）。',
    '9. 需要用户输入或确认偏好时使用 ask_user，不要自行假设。',
    '10. 执行中发现重要信息或潜在问题时使用 notify_user 主动告知用户。',
    '10.1 任务或附件中出现图片（本地路径或 http(s) URL，常见于任务文本中的“[附件]”块或截图）时，必须用 image_analyze 把图片交给多模态模型分析，不要凭文件名猜测内容。image 传图片路径/URL，question 用简体中文写清要从图里得到什么。',
    '10.2 简单识图任务（例如“这是什么图/图里是什么”）在一次 image_analyze 已得到可用描述后，应立即 finish。若无法确认具体来源、游戏、人物、地点或品牌，必须说明“无法仅凭图片确认”，并给出可见证据和低置信猜测；不要反复调用同一张图来放大猜测。',
    '10.3 对同一张图片最多连续调用 2 次 image_analyze；第二次只用于明确不同的问题（如 OCR、局部细节、真假核验）。不要编造图片中没有的 UI、文字、按钮、角色名、怪物、道具或数值。',
    '11. 当任务涉及多个独立的子目标时（如分析多个文件、查询多个信息源、批量处理），自动使用 spawn 工具并行分发给子 Agent 执行，显著提升效率。最多支持 5 个并行任务。',
    '12. 涉及医保、社保、签证、贷款、股票、基金、汇率、法律、法规、政策、许可、合规等高风险或合规性信息时，必须优先从官方来源核验；如果未能核验，finish 答案必须明确说明“未能完成官方核验”，不要把记忆或常识包装成已确认结论。',
    '13. finish 之前自检：当任务要求基于网页/官网内容作答，但浏览操作没有真正取得目标页面的实质内容（如反复超时、只到达主页、被反爬挡住），不要用模型常识包装成“已确认结论”。要么继续尝试（换路径、换工具、换源站），要么在 answer 里明确说明“未能从目标页面取得信息，以下来自常识仅供参考”。',
    '14. 查询酒店/机票/电商等实时价格时，优先用 web_search 获取价格区间或聚合报价；这类价格依赖具体入住/出行日期、常需登录且受反爬限制，难以直接抓取。若拿不到确切数字，直接 finish 给出区间与查询入口，并如实说明“未取得实时精确价”，不要在单个站点反复操作空转。',
    '15. 浏览器/Chrome 操作要及时止损：对同一目标连续约 5 步仍未取得实质数据时，停止更换手段反复尝试，直接 finish 汇总已知信息并说明未能取得的部分。',
    ...(chromeDetails ? ['16. 当内置浏览器被反爬拦截时，改用 Chrome MCP 操作真实浏览器访问同一页面。'] : []),
    ...ideLines,
    ...chromeLines,
  ];
}

function buildReadonlyAgentRuleLines(systemPrompt: string | null) {
  return [
    '你是只读子 Agent，只负责分析并返回结果。',
    '禁止写文件、运行终端、操作浏览器/Chrome/IDE/macOS、询问或通知用户、继续 spawn。',
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
    '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。',
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
  contents.push({
    role: 'user',
    parts: [{ text: JSON.stringify({ task, step, history: promptHistory, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}), ...(recentSearchesHint ? { recentSearchesHint } : {}) }) }],
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
  const capabilityContext = { task, history, observation };
  const ideEnabled = isIdeMcpEnabled();
  const ideDetails = shouldIncludeIdePromptDetails(capabilityContext);
  const chromeEnabled = isChromeMcpAvailable();
  const chromeDetails = shouldIncludeChromePromptDetails(capabilityContext);
  const sanitizedConversation = sanitizeConversationHistory(conversationHistory);
  const conversationSummary = sanitizedConversation.length
    ? '\n\n之前的对话（仅用于理解当前 task 的指代，不得继续旧任务）：\n' + sanitizedConversation
        .map(message => `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`)
        .join('\n')
    : '';

  const recentUrlsHint = buildRecentUrlsHint(history);
  const recentSearchesHint = buildRecentSearchesHint(history);
  const promptHistory = compactAgentHistory(history, undefined, undefined, task);

  if (toolMode === 'readonly') {
    return [
      {
        role: 'system',
        content: [
          '每个步骤必须且只能输出一个 JSON 对象。',
          '可用动作只有：fs list_dir/read_file/get_file_info/search_files；search web_search；vision image_analyze；codegraph codegraph_query；core finish。',
          ...buildReadonlyAgentRuleLines(systemPrompt || null),
        ].filter(Boolean).join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ task, step, history: compactAgentHistory(history, compact ? 2 : 6, undefined, task), observation }),
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
          '常识问答、闲聊、解释类任务必须直接 finish，不要调用工具。',
          'answer 用简体中文，简洁直接。',
          systemPrompt ? `附加约束：${systemPrompt}` : '',
        ].filter(Boolean).join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ task, step, history: compactAgentHistory(history, 2, 1500, task), observation }),
      },
    ];
  }

  return [
    {
      role: 'system',
      content: [
        '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。',
        '你只能输出一个 JSON 对象，不要输出 Markdown，不要解释。',
        '输出格式固定为 {"rationale":"简短理由","action":{...}}。示例：',
        '{"rationale":"搜索天气","action":{"tool":"search","type":"web_search","query":"杭州今日天气"}}',
        '{"rationale":"任务完成","action":{"type":"finish","answer":"最终结果"}}',
        '可用动作签名（括号内为主要参数）：',
        'browser: navigate(url), click(elementId), type(elementId,text), wait(seconds), scroll(direction,amount), get_page_content(), http_fetch(url,extractLinks?), parallel_fetch(urls)',
        'fs: list_dir(path), get_file_info(path), read_file(path), write_file(path,content,append), search_files(query,path,include?)',
        'terminal: run_safe(command), run_confirmed(command), run_review(command)',
        'macos: activate_app(app), open_app(app), list_windows(), capture_screen(), type_text(text), press_key(key,modifiers), click_at(x,y)',
        'search: web_search(query,maxResults?)；codegraph: codegraph_query(query)；vision: image_analyze(image,question)；spawn: spawn(tasks:string[])。spawn 的 tasks 必须是 1-5 个自然语言子任务字符串，不是工具动作对象；示例：{"tool":"spawn","type":"spawn","tasks":["抓取页面 A 并提取关键数据","抓取页面 B 并核对来源"]}',
        ...(ideEnabled && ideDetails ? ['ide: ide_list_tools(refresh?), ide_call_tool(toolName,arguments)'] : []),
        ...(chromeEnabled && chromeDetails ? ['chrome: chrome_list_tools(refresh?), chrome_call_tool(toolName,arguments,refreshTools?)'] : []),
        'core: ask_user(question), notify_user(message,level), finish(answer)',
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
      content: JSON.stringify({ task, step, history: promptHistory, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}), ...(recentSearchesHint ? { recentSearchesHint } : {}) }),
    },
  ];
}
