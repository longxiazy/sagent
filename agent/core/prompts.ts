import { buildIdePromptLines, isIdeMcpEnabled } from '../tools/ide/mcp-client.ts';
import { buildChromePromptLines, isChromeMcpEnabled } from '../tools/chrome/mcp-client.ts';

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

export function buildDesktopAgentSystemPrompt(systemPrompt: string | null) {
  const ideLines = buildIdePromptLines();
  const chromeLines = buildChromePromptLines();
  return [
    '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。',
    '通过工具调用完成任务，只能使用提供的工具，不要输出 JSON 以外的文本。',
    '规则：',
    '1. 只有 observation.browser.elements 中存在的 elementId 才能用于 click/type。',
    '2. 优先使用已知信息，不要重复无意义截图或重复读同一文件。任务一旦完成，必须立即返回 {"action":{"tool":"core","type":"finish","answer":"结果"}}，绝不能重复执行已成功的动作。',
    '2.1 识别任务中的并行机会：当需要处理多个独立对象（多个文件、多个 URL、多个关键词）时，优先考虑用 spawn 并行处理而非串行逐个处理。',
    '2.2 若任务是常识问答、闲聊，或依据已有知识即可直接回答（无需读取文件/网页/桌面/终端），直接用 finish 返回答案，不要为了「显得在执行」而调用 list_dir、read_file 等探索性工具。',
    '3. 文件写入、终端确认命令、桌面键鼠输入可能需要用户批准，被拒绝后请尝试替代方案。',
    '4. cd/pushd/popd 等目录切换命令使用 run_review，需要用户审批。',
    '5. answer 用简体中文，简洁直接。',
    '6. 需要全网搜索关键词时，优先使用 web_search（DuckDuckGo，返回标题/URL/摘要），再用 http_fetch 抓具体页面。禁止直接 navigate 到 Google/Bing/百度搜索结果页，这些页面会触发反爬。',
    '7. 需要用户输入或确认偏好时使用 ask_user，不要自行假设。',
    '8. 执行中发现重要信息或潜在问题时使用 notify_user 主动告知用户。',
    '8.1 任务或附件中出现图片（本地路径或 http(s) URL，常见于任务文本中的”[附件]”块或截图）时，必须用 image_analyze 工具把图片交给多模态模型分析，不要凭文件名猜测内容。',
    '9. 当任务涉及多个独立的子目标时（如分析多个文件、查询多个信息源、批量处理），自动使用 spawn 工具并行分发给子 Agent 执行，显著提升效率。最多支持 5 个并行任务。',
    '10. 涉及医保、社保、签证、贷款、股票、基金、汇率、法律、法规、政策、许可、合规等高风险或合规性信息时，必须优先从官方来源核验；如果未能核验，finish 答案必须明确说明”未能完成官方核验”，不要把记忆或常识包装成已确认结论。',
    '11. finish 之前自检：当任务要求基于网页/官网内容作答，但你的浏览操作（navigate/click/take_snapshot/http_fetch 等）没有真正取得目标页面的实质内容（如反复超时、只到达主页、被反爬挡住），不要用模型常识包装成”已确认结论”。要么继续尝试（换路径、换工具、换源站），要么在 answer 里明确说明”未能从目标页面取得信息，以下来自常识仅供参考”。',
    ...(isChromeMcpEnabled() ? ['11. 当内置浏览器被反爬拦截（CAPTCHA、人机验证、403、Cloudflare 等）时，立即改用 chrome_call_tool（navigate_page / take_snapshot / click / fill 等）操作真实 Chrome 浏览器访问同一页面。'] : []),
    ...ideLines,
    ...chromeLines,
    systemPrompt ? `附加约束：${systemPrompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildClaudeTaskMessages({
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
  const messages = [];
  if (conversationHistory?.length) {
    for (const msg of conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  const recentUrlsHint = buildRecentUrlsHint(history);
  messages.push({
    role: 'user',
    content: JSON.stringify({ task, step, history, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}) }),
  });
  return messages;
}

// Gemini 决策消息：复用 Claude 那套「把 task/step/history/observation 这坨 JSON 塞进一个
// user part」的思路，但产出 Gemini 的 contents 格式（assistant→model）。system 由 provider 单独传。
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
  if (conversationHistory?.length) {
    for (const msg of conversationHistory) {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    }
  }
  const recentUrlsHint = buildRecentUrlsHint(history);
  contents.push({
    role: 'user',
    parts: [{ text: JSON.stringify({ task, step, history, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}) }) }],
  });
  return { contents };
}

export function buildNvidiaTaskMessages({
  task,
  systemPrompt,
  step,
  history,
  observation,
  conversationHistory,
}: {
  task: string;
  systemPrompt?: string | null;
  step: number;
  history: any[];
  observation: any;
  conversationHistory?: Array<{ role: string; content: string }>;
}) {
  const ideEnabled = isIdeMcpEnabled();
  const ideLines = buildIdePromptLines();
  const chromeEnabled = isChromeMcpEnabled();
  const chromeLines = buildChromePromptLines();
  const conversationSummary = conversationHistory?.length
    ? '\n\n之前的对话（供参考）：\n' + conversationHistory
        .map(message => `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`)
        .join('\n')
    : '';

  const recentUrlsHint = buildRecentUrlsHint(history);

  return [
    {
      role: 'system',
      content: [
        '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。',
        '你只能输出一个 JSON 对象，不要输出 Markdown，不要解释。',
        '可用动作示例：',
        '{"rationale":"打开网页","action":{"tool":"browser","type":"navigate","url":"https://example.com"}}',
        '{"rationale":"点击网页元素","action":{"tool":"browser","type":"click","elementId":"3"}}',
        '{"rationale":"读取目录","action":{"tool":"fs","type":"list_dir","path":"."}}',
        '{"rationale":"读取文件","action":{"tool":"fs","type":"read_file","path":"README.md"}}',
        '{"rationale":"写文件","action":{"tool":"fs","type":"write_file","path":"notes.txt","content":"内容","append":false}}',
        '{"rationale":"搜索文件内容","action":{"tool":"fs","type":"search_files","query":"关键词","path":".","include":"*.js"}}',
        '{"rationale":"运行只读命令","action":{"tool":"terminal","type":"run_safe","command":"pwd"}}',
        '{"rationale":"运行需确认命令","action":{"tool":"terminal","type":"run_confirmed","command":"git status"}}',
        '{"rationale":"切换目录","action":{"tool":"terminal","type":"run_review","command":"cd /path/to/dir"}}',
        '{"rationale":"切换应用","action":{"tool":"macos","type":"activate_app","app":"Finder"}}',
        '{"rationale":"打开应用","action":{"tool":"macos","type":"open_app","app":"Google Chrome"}}',
        '{"rationale":"列出窗口","action":{"tool":"macos","type":"list_windows"}}',
        '{"rationale":"屏幕截图","action":{"tool":"macos","type":"capture_screen"}}',
        '{"rationale":"桌面输入文字","action":{"tool":"macos","type":"type_text","text":"hello"}}',
        '{"rationale":"桌面按键","action":{"tool":"macos","type":"press_key","key":"enter","modifiers":["command"]}}',
        '{"rationale":"点击桌面坐标","action":{"tool":"macos","type":"click_at","x":640,"y":480}}',
        '{"rationale":"向下滚动页面","action":{"tool":"browser","type":"scroll","direction":"down","amount":3}}',
        '{"rationale":"获取浏览器当前页面文本内容","action":{"tool":"browser","type":"get_page_content"}}',
        '{"rationale":"抓取网页内容","action":{"tool":"browser","type":"http_fetch","url":"https://example.com"}}',
        '{"rationale":"搜索并提取链接","action":{"tool":"browser","type":"http_fetch","url":"https://example.com/search?q=关键词","extractLinks":true}}',
        '{"rational":"并发抓取多个页面","action":{"tool":"browser","type":"parallel_fetch","urls":["https://example.com/a","https://example.com/b"]}}',
        '{"rationale":"网络搜索关键词","action":{"tool":"search","type":"web_search","query":"2026 北京最低工资标准"}}',
        '{"rationale":"查询项目代码图谱定位相关模块","action":{"tool":"codegraph","type":"codegraph_query","query":"记忆 memory"}}',
        '{"rationale":"分析图片内容","action":{"tool":"vision","type":"image_analyze","image":"/abs/path/to/image.png","question":"图片里有什么内容？请详细描述。"}}',
        '{"rationale":"并行分析多个文件","action":{"tool":"spawn","type":"spawn","tasks":["分析 src/index.ts 的架构","检查 test/ 目录的测试覆盖率","搜索项目中的 TODO 注释"]}}',
        ...(ideEnabled
          ? [
              '{"rationale":"查看 IDE 可用工具","action":{"tool":"ide","type":"ide_list_tools"}}',
              '{"rationale":"调用 IDE 工具获取运行配置","action":{"tool":"ide","type":"ide_call_tool","toolName":"get_run_configurations","arguments":{}}}',
            ]
          : []),
        ...(chromeEnabled
          ? [
              '{"rationale":"调用 Chrome 工具截图","action":{"tool":"chrome","type":"chrome_call_tool","toolName":"take_screenshot","arguments":{}}}',
              '{"rationale":"刷新 Chrome 工具列表（仅在工具缺失/调用失败时使用）","action":{"tool":"chrome","type":"chrome_list_tools","refresh":true}}',
            ]
          : []),
        '{"rationale":"向用户提问","action":{"tool":"core","type":"ask_user","question":"你希望使用什么命名规范？"}}',
        '{"rationale":"发现重要问题需告知用户","action":{"tool":"core","type":"notify_user","message":"发现 3 个硬编码 API 密钥","level":"warning"}}',
        '{"rationale":"完成任务","action":{"type":"finish","answer":"最终结果"}}',
        '重要：每个步骤必须且只能输出一个 JSON 动作。如果你已经收集到足够信息并可以直接回答用户问题，请使用 finish 动作输出答案。绝对不要在 JSON 之外输出解释文字。',
        '规则：',
        '1. 只有 observation.browser.elements 中存在的 elementId 才能用于 browser.click / browser.type。',
        '2. 优先使用已知信息，不要重复无意义截图或重复读同一文件。',
        '2.1 识别任务中的并行机会：当需要处理多个独立对象（多个文件、多个 URL、多个关键词）时，优先考虑用 spawn 并行处理而非串行逐个处理。',
        '2.2 若任务是常识问答、闲聊，或依据已有知识即可直接回答（无需读取文件/网页/桌面/终端），直接用 finish 返回答案，不要为了「显得在执行」而调用 list_dir、read_file 等探索性工具。',
        '3. 文件写入、终端确认命令、桌面键鼠输入可能需要用户批准，被拒绝后请尝试替代方案。',
        '4. cd/pushd/popd 等目录切换命令使用 run_review，会触发用户审批。',
        '5. answer 用简体中文，简洁直接。',
        '6. 需要全网搜索关键词时，优先使用 web_search（DuckDuckGo，返回标题/URL/摘要），再用 http_fetch 抓具体页面。禁止直接 navigate 到 Google/Bing/百度搜索结果页。',
        '7. http_fetch 和 navigate 都通过浏览器执行，可以处理需要 JS 渲染的页面。',
        '8. 需要同时获取多个页面时，使用 parallel_fetch 并发抓取（最多5个URL）。',
        '9. 需要用户输入或确认偏好时使用 ask_user。',
        '10. 发现重要信息或问题时使用 notify_user 主动告知用户。',
        '10.1 任务或附件中出现图片（本地路径或 http(s) URL，常见于任务文本中的”[附件]”块或截图）时，必须用 image_analyze（tool=vision）把图片交给多模态模型分析，不要凭文件名猜测内容。image 传图片路径/URL，question 用简体中文写清要从图里得到什么。',
        '11. 当任务涉及多个独立的子目标时（如分析多个文件、查询多个信息源、批量处理），自动使用 spawn 工具并行分发给子 Agent 执行，显著提升效率。最多支持 5 个并行任务。',
        '12. 涉及医保、社保、签证、贷款、股票、基金、汇率、法律、法规、政策、许可、合规等高风险或合规性信息时，必须优先从官方来源核验；如果未能核验，finish 答案必须明确说明”未能完成官方核验”，不要把记忆或常识包装成已确认结论。',
        ...(chromeEnabled ? ['12. 当内置浏览器被反爬拦截（CAPTCHA、人机验证、403、Cloudflare 等）时，立即改用 chrome_call_tool（navigate_page / take_snapshot / click / fill 等）操作真实 Chrome 浏览器。'] : []),
        ...ideLines,
        ...chromeLines,
        systemPrompt ? `附加约束：${systemPrompt}` : '',
        conversationSummary,
      ]
        .filter(Boolean)
        .join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({ task, step, history, observation, ...(recentUrlsHint ? { recentUrlsHint } : {}) }),
    },
  ];
}
