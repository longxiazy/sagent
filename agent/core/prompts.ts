import { buildIdePromptLines, isIdeMcpEnabled } from '../tools/ide/mcp-client.ts';
import { buildChromePromptLines, isChromeMcpEnabled } from '../tools/chrome/mcp-client.ts';

export function buildDesktopAgentSystemPrompt(systemPrompt: string | null) {
  const ideLines = buildIdePromptLines();
  const chromeLines = buildChromePromptLines();
  return [
    '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。',
    '通过工具调用完成任务，只能使用提供的工具，不要输出 JSON 以外的文本。',
    '规则：',
    '1. 只有 observation.browser.elements 中存在的 elementId 才能用于 click/type。',
    '2. 优先使用已知信息，不要重复无意义截图或重复读同一文件。任务一旦完成，必须立即返回 {"action":{"tool":"core","type":"finish","answer":"结果"}}，绝不能重复执行已成功的动作。',
    '3. 文件写入、终端确认命令、桌面键鼠输入可能需要用户批准，被拒绝后请尝试替代方案。',
    '4. cd/pushd/popd 等目录切换命令使用 run_review，需要用户审批。',
    '5. answer 用简体中文，简洁直接。',
    '6. 禁止使用 Google、百度、Bing 等搜索引擎网站搜索信息，这些网站会触发反爬机制导致任务失败。需要获取网页内容时使用 navigate 或 http_fetch 打开目标页面。',
    '7. 需要用户输入或确认偏好时使用 ask_user，不要自行假设。',
    '8. 执行中发现重要信息或潜在问题时使用 notify_user 主动告知用户。',
    ...(isChromeMcpEnabled() ? ['9. 当内置浏览器被反爬拦截（CAPTCHA、人机验证、403、Cloudflare 等）时，立即改用 chrome_call_tool（navigate_page / take_snapshot / click / fill 等）操作真实 Chrome 浏览器访问同一页面。'] : []),
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
  messages.push({
    role: 'user',
    content: JSON.stringify({ task, step, history, observation }, null, 2),
  });
  return messages;
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
        ...(ideEnabled
          ? [
              '{"rationale":"查看 IDE 可用工具","action":{"tool":"ide","type":"ide_list_tools"}}',
              '{"rationale":"调用 IDE 工具获取运行配置","action":{"tool":"ide","type":"ide_call_tool","toolName":"get_run_configurations","arguments":{}}}',
            ]
          : []),
        ...(chromeEnabled
          ? [
              '{"rationale":"查看 Chrome DevTools 可用工具","action":{"tool":"chrome","type":"chrome_list_tools"}}',
              '{"rationale":"调用 Chrome 工具截图","action":{"tool":"chrome","type":"chrome_call_tool","toolName":"take_screenshot","arguments":{}}}',
            ]
          : []),
        '{"rationale":"向用户提问","action":{"tool":"core","type":"ask_user","question":"你希望使用什么命名规范？"}}',
        '{"rationale":"发现重要问题需告知用户","action":{"tool":"core","type":"notify_user","message":"发现 3 个硬编码 API 密钥","level":"warning"}}',
        '{"rationale":"完成任务","action":{"type":"finish","answer":"最终结果"}}',
        '重要：每个步骤必须且只能输出一个 JSON 动作。如果你已经收集到足够信息并可以直接回答用户问题，请使用 finish 动作输出答案。绝对不要在 JSON 之外输出解释文字。',
        '规则：',
        '1. 只有 observation.browser.elements 中存在的 elementId 才能用于 browser.click / browser.type。',
        '2. 优先使用已知信息，不要重复无意义截图或重复读同一文件。',
        '3. 文件写入、终端确认命令、桌面键鼠输入可能需要用户批准，被拒绝后请尝试替代方案。',
        '4. cd/pushd/popd 等目录切换命令使用 run_review，会触发用户审批。',
        '5. answer 用简体中文，简洁直接。',
        '6. 禁止使用 Google、百度、Bing 等搜索引擎网站搜索信息，这些网站会触发反爬机制导致任务失败。需要获取网页内容时使用 http_fetch 或 navigate 打开目标页面。',
        '7. http_fetch 和 navigate 都通过浏览器执行，可以处理需要 JS 渲染的页面。',
        '8. 需要同时获取多个页面时，使用 parallel_fetch 并发抓取（最多5个URL）。',
        '9. 需要用户输入或确认偏好时使用 ask_user。',
        '10. 发现重要信息或问题时使用 notify_user 主动告知用户。',
        ...(chromeEnabled ? ['11. 当内置浏览器被反爬拦截（CAPTCHA、人机验证、403、Cloudflare 等）时，立即改用 chrome_call_tool（navigate_page / take_snapshot / click / fill 等）操作真实 Chrome 浏览器。'] : []),
        ...ideLines,
        ...chromeLines,
        systemPrompt ? `附加约束：${systemPrompt}` : '',
        conversationSummary,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ task, step, history, observation }),
    },
  ];
}
