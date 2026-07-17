import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiAgentPromptPayload,
  buildGeminiTaskMessages,
  buildNvidiaActionExampleLines,
  buildNvidiaTaskMessages,
  compactAgentHistory,
  sanitizeConversationHistory,
  selectGeminiToolNames,
} from '../agent/core/prompts.ts';
import { estimatePayloadTokens } from '../agent/core/context-estimate.ts';
import { compactToolResult } from '../agent/core/result-extraction.ts';
import { createModelTools } from '../agent/core/tool-definitions.ts';

describe('agent prompts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('keeps system prompts cacheable while injecting current time into task payloads', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T16:05:06.000Z'));

    const gemini = buildGeminiAgentPromptPayload({
      task: '查询苹果最新股价',
      step: 1,
      history: [],
      observation: {},
    });
    const nvidia = buildNvidiaTaskMessages({
      task: '查询苹果最新股价',
      step: 1,
      history: [],
      observation: {},
    });
    const compact = buildNvidiaTaskMessages({
      task: '查询苹果最新股价',
      step: 1,
      history: [],
      observation: {},
      compact: true,
    });

    for (const prompt of [gemini.systemInstruction, nvidia[0].content, compact[0].content]) {
      expect(prompt).toContain('currentDateTime');
      expect(prompt).toContain('不得猜测年份');
      expect(prompt).not.toContain('2026-07-14T16:05:06.000Z');
    }

    const geminiPayload = JSON.parse(gemini.contents.at(-1)!.parts[0].text);
    const nvidiaPayload = JSON.parse(nvidia[1].content);
    const compactPayload = JSON.parse(compact[1].content);
    for (const payload of [geminiPayload, nvidiaPayload, compactPayload]) {
      expect(payload.currentDateTime).toEqual(expect.objectContaining({
        localDateTime: expect.any(String),
        timeZone: expect.any(String),
        iso: '2026-07-14T16:05:06.000Z',
      }));
    }

    vi.setSystemTime(new Date('2026-07-14T17:05:06.000Z'));
    const later = buildNvidiaTaskMessages({
      task: '查询苹果最新股价',
      step: 1,
      history: [],
      observation: {},
    });

    expect(later[0].content).toBe(nvidia[0].content);
    expect(JSON.parse(later[1].content).currentDateTime.iso).toBe('2026-07-14T17:05:06.000Z');
  });

  it('provides detailed, valid NVIDIA JSON examples for every built-in action', () => {
    const lines = buildNvidiaActionExampleLines();
    const definitions = createModelTools({ includeChromeMcp: false });
    const toolsByName = new Map(definitions.map(tool => [tool.name, tool]));

    expect(lines).toHaveLength(definitions.length);
    for (const line of lines) {
      const example = JSON.parse(line);
      expect(example).toEqual(expect.objectContaining({
        rationale: expect.any(String),
        action: expect.any(Object),
      }));
      expect(example.action.tool).toEqual(expect.any(String));
      expect(example).not.toHaveProperty('rational');
      const definition = toolsByName.get(example.action.type);
      expect(definition, `missing tool definition for ${line}`).toBeDefined();
      expect(example.rationale).toBe(definition!.example.rationale);
      for (const required of definition!.input_schema.required || []) {
        expect(Object.prototype.hasOwnProperty.call(example.action, required), `${line} is missing ${required}`).toBe(true);
      }
    }

    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const conditional = buildNvidiaActionExampleLines({ chromeEnabled: true });
    expect(lines.some(line => line.includes('chrome_call_tool'))).toBe(false);
    expect(conditional.some(line => line.includes('chrome_call_tool'))).toBe(true);
  });

  it('keeps built-in browser tools read-only', () => {
    const names = createModelTools({ includeChromeMcp: false }).map(tool => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'navigate',
      'wait',
      'scroll',
      'get_page_content',
      'http_fetch',
    ]));
    expect(names).not.toContain('click');
    expect(names).not.toContain('type');
  });

  it('gives NVIDIA models an explicit single-action JSON output contract', () => {
    const messages = buildNvidiaTaskMessages({
      task: '打开示例网页',
      step: 1,
      history: [],
      observation: {},
    });
    const systemPrompt = messages[0].content;

    expect(systemPrompt).toContain('每个步骤必须且只能输出一个合法的 JSON 对象');
    expect(systemPrompt).toContain('禁止输出 Markdown、代码块、注释、解释或其他文字');
    expect(systemPrompt).toContain('固定顶层结构为 {"rationale":"一句话理由","action":{"tool":"工具名","type":"动作类型",...}}');
    expect(systemPrompt).toContain('rationale 只说明当前动作的直接目的');
    expect(systemPrompt).toContain('finish 固定使用 {"tool":"core","type":"finish","answer":"最终结果"}');
    expect(systemPrompt).toContain('每次只能选择一个已启用动作');
    expect(systemPrompt).not.toContain('type(elementId,text,submit?)');
    expect(systemPrompt).not.toContain('click(elementId)');
    expect(systemPrompt).toContain('内置 browser 是只读信息浏览器');
    expect(systemPrompt).toContain('scroll(direction,amount?)');
  });

  it('builds a finish-only finalization prompt after tool steps are exhausted', () => {
    const context = {
      task: '总结医保官网信息',
      step: 9,
      history: [{
        step: 8,
        action: { tool: 'browser', type: 'get_page_content' },
        result: '官方页面日期：2025-01-14，在职报销60%，退休报销80%。',
      }],
      observation: { skipped: true },
      finalOnly: true,
    };
    const nvidia = buildNvidiaTaskMessages(context);
    const gemini = buildGeminiAgentPromptPayload(context);
    const geminiToolNames = gemini.tools[0].functionDeclarations.map(tool => tool.name);

    expect(nvidia[0].content).toContain('最终总结器');
    expect(nvidia[0].content).toContain('"tool":"core","type":"finish"');
    expect(nvidia[0].content).not.toContain('http_fetch(');
    expect(gemini.systemInstruction).toContain('只能调用 finish');
    expect(geminiToolNames).toEqual(['finish']);
  });

  it('adds a recent search hint for repeated or failed web_search queries', () => {
    const { contents } = buildGeminiTaskMessages({
      task: '白天的a股呢',
      step: 3,
      history: [
        {
          step: 1,
          action: { tool: 'search', type: 'web_search', query: '2026年7月3日 A股收盘行情' },
          result: 'web_search 失败：DuckDuckGo 触发反爬验证。',
          resultStatus: 'failed',
        },
      ],
      observation: {},
    });

    const payload = JSON.parse(contents.at(-1)!.parts[0].text);

    expect(payload.recentSearchesHint).toContain('2026年7月3日 A股收盘行情');
    expect(payload.recentSearchesHint).toContain('不要原样重复');
  });

  it('builds a compact OpenAI-compatible prompt for small context models', () => {
    const full = buildNvidiaTaskMessages({
      task: '你能做啥',
      step: 1,
      history: [],
      observation: {},
      conversationHistory: [
        { role: 'user', content: '你能做啥' },
        { role: 'assistant', content: 'Desktop Agent 失败：500 Internal Server Error' },
      ],
    });
    const compact = buildNvidiaTaskMessages({
      task: '你能做啥',
      step: 1,
      history: [],
      observation: {},
      conversationHistory: [
        { role: 'user', content: '你能做啥' },
        { role: 'assistant', content: 'Desktop Agent 失败：500 Internal Server Error' },
      ],
      compact: true,
    });

    expect(estimatePayloadTokens(compact)).toBeLessThan(estimatePayloadTokens(full));
    expect(compact[0].content).not.toContain('Chrome DevTools');
    expect(compact[0].content).not.toContain('Desktop Agent 失败');
    expect(compact[0].content).toContain('core: ask_user(question), notify_user(message,level?), finish(answer)');
    expect(compact[0].content).toContain('{"tool":"core","type":"finish","answer":"最终结果"}');
    expect(compact[0].content).not.toContain('write_file(');
    expect(compact[0].content).not.toContain('run_confirmed(');
  });

  it('includes behavior rules only for capabilities enabled by the current task', () => {
    const casual = buildNvidiaTaskMessages({
      task: '你好，介绍一下你自己',
      step: 1,
      history: [],
      observation: {},
    })[0].content;
    const web = buildNvidiaTaskMessages({
      task: '查询今天苏州天气',
      step: 1,
      history: [],
      observation: {},
    })[0].content;
    const image = buildNvidiaTaskMessages({
      task: '分析这张图片\n[附件]\n- 图片: /tmp/example.png',
      step: 1,
      history: [],
      observation: {},
    })[0].content;

    expect(casual).not.toContain('文件写入和终端确认命令');
    expect(casual).not.toContain('内置 browser 是只读信息浏览器');
    expect(casual).not.toContain('图片任务必须使用 image_analyze');
    expect(casual).not.toContain('酒店、机票、电商');
    expect(web).toContain('内置 browser 是只读信息浏览器');
    expect(web).toContain('web_search 只用于发现来源');
    expect(web).not.toContain('图片任务必须使用 image_analyze');
    expect(image).toContain('图片任务必须使用 image_analyze');
    expect(image).not.toContain('内置 browser 是只读信息浏览器');
  });

  it('keeps NVIDIA action examples scoped to the current task', () => {
    const casual = buildNvidiaTaskMessages({
      task: '你好，介绍一下你自己',
      step: 1,
      history: [],
      observation: {},
    });
    const code = buildNvidiaTaskMessages({
      task: '检查项目代码并运行测试',
      step: 1,
      history: [],
      observation: {},
    });

    expect(casual[0].content).not.toContain('run_safe(command)');
    expect(casual[0].content).not.toContain('read_file(path)');
    expect(code[0].content).toContain('run_safe(command)');
    expect(code[0].content).toContain('read_file(path)');
    expect(estimatePayloadTokens(casual)).toBeLessThan(900);
    expect(estimatePayloadTokens(code)).toBeLessThan(1200);
  });

  it('keeps one representative JSON example per enabled tool group', () => {
    const countExamples = (content: string) => content
      .split('\n')
      .filter(line => line.startsWith('{"rationale":')).length;
    const casual = buildNvidiaTaskMessages({ task: '你好', step: 1, history: [], observation: {} })[0].content;
    const web = buildNvidiaTaskMessages({ task: '查询今天苏州天气', step: 1, history: [], observation: {} })[0].content;
    const code = buildNvidiaTaskMessages({ task: '检查项目代码并运行测试', step: 1, history: [], observation: {} })[0].content;

    expect(countExamples(casual)).toBe(2);
    expect(countExamples(web)).toBe(3);
    expect(countExamples(code)).toBe(5);
    expect(web).toContain('{"tool":"browser","type":"http_fetch"');
    expect(web).not.toContain('{"tool":"browser","type":"navigate","url":"https://example.com"}');
    expect(web).toContain('http_fetch(url,extractLinks?)');
    expect(code).toContain('write_file(path,content,append?)');
    expect(code).toContain('run_confirmed(command)');
  });

  it('keeps Chrome MCP details lazy for unrelated tasks', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const common = {
      step: 1,
      history: [],
      observation: {},
    };
    const weather = buildNvidiaTaskMessages({
      ...common,
      task: '杭州今天天气怎么样？',
    });
    const chromeTask = buildNvidiaTaskMessages({
      ...common,
      task: '用 Chrome DevTools 检查页面网络请求',
    });

    expect(weather[0].content).not.toContain('Chrome MCP 已启用但默认不展开');
    expect(weather[0].content).not.toContain('Chrome DevTools 工具可用于');
    expect(chromeTask[0].content).toContain('Chrome DevTools 工具可用于');
    expect(estimatePayloadTokens(weather)).toBeLessThan(estimatePayloadTokens(chromeTask));
  });

  it('expands Chrome MCP details after the built-in browser is blocked', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const messages = buildNvidiaTaskMessages({
      task: '继续获取页面内容',
      step: 2,
      history: [{
        step: 1,
        action: { tool: 'browser', type: 'http_fetch', url: 'https://example.com' },
        result: 'HTTP 403 Cloudflare CAPTCHA 人机验证',
      }],
      observation: {},
    });

    expect(messages[0].content).toContain('Chrome DevTools 工具可用于');
    expect(messages[0].content).not.toContain('Chrome MCP 已启用但默认不展开');
  });

  it('omits inactive Chrome capabilities from Gemini prompts and tools', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const payload = buildGeminiAgentPromptPayload({
      task: '杭州今天天气怎么样？',
      step: 1,
      history: [],
      observation: {},
    });
    const toolNames = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(payload.systemInstruction).not.toContain('Chrome MCP');
    expect(toolNames).not.toContain('chrome_list_tools');
    expect(toolNames).not.toContain('chrome_call_tool');
  });

  it('loads Gemini Chrome capabilities when the task requires them', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const payload = buildGeminiAgentPromptPayload({
      task: '用 Chrome DevTools 检查页面问题',
      step: 1,
      history: [],
      observation: {},
    });
    const toolNames = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(payload.systemInstruction).toContain('Chrome DevTools 工具可用于');
    expect(toolNames).toContain('chrome_list_tools');
    expect(toolNames).toContain('chrome_call_tool');
  });

  it('routes ordinary web interaction tasks to Chrome MCP', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const payload = buildGeminiAgentPromptPayload({
      task: '登录网站并填写表单后提交',
      step: 1,
      history: [],
      observation: {},
    });
    const toolNames = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(payload.systemInstruction).toContain('网页交互以及 CAPTCHA');
    expect(toolNames).toContain('chrome_call_tool');
    expect(toolNames).not.toContain('click');
    expect(toolNames).not.toContain('type');
  });

  it('reports unavailable Chrome MCP instead of advertising missing interaction tools', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'false');
    const payload = buildGeminiAgentPromptPayload({
      task: '登录网站并提交表单',
      step: 1,
      history: [],
      observation: {},
    });
    const toolNames = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(payload.systemInstruction).toContain('当前未启用 Chrome MCP');
    expect(toolNames).not.toContain('chrome_list_tools');
    expect(toolNames).not.toContain('chrome_call_tool');
  });

  it('keeps Chrome interaction tools in compact prompts when Chrome MCP is available', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    const messages = buildNvidiaTaskMessages({
      task: '登录网站并填写表单后提交',
      step: 1,
      history: [],
      observation: {},
      compact: true,
    });

    expect(messages[0].content).toContain('chrome_list_tools(refresh?)');
    expect(messages[0].content).toContain('chrome_call_tool(toolName,arguments?,refreshTools?)');
    expect(messages[0].content).not.toContain('browser: click');
    expect(messages[0].content).not.toContain('browser: type');
  });

  it('reports unavailable Chrome MCP in compact interaction prompts', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'false');
    const messages = buildNvidiaTaskMessages({
      task: '登录网站并提交表单',
      step: 1,
      history: [],
      observation: {},
      compact: true,
    });

    expect(messages[0].content).toContain('当前未启用 Chrome MCP');
    expect(messages[0].content).not.toContain('chrome_call_tool(');
    expect(messages[0].content).not.toContain('browser: click');
    expect(messages[0].content).not.toContain('browser: type');
  });

  it('keeps shared Gemini and NVIDIA agent rules semantically identical', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T16:05:06.000Z'));
    const context = {
      task: '读取官网并总结内容',
      systemPrompt: '[Agent 记忆]\n偏好：简洁回答',
      step: 2,
      history: [{
        step: 1,
        action: { tool: 'browser', type: 'navigate', url: 'https://example.com' },
        result: '页面内容',
      }],
      observation: { browser: { text: 'Example page' } },
      conversationHistory: [
        { role: 'user', content: '先打开官网' },
        { role: 'assistant', content: '好的' },
      ],
    };
    const gemini = buildGeminiAgentPromptPayload(context);
    const nvidia = buildNvidiaTaskMessages(context);
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const ruleSection = (value: string) => normalize(value.split('规则：')[1].split('附加约束：')[0]);

    expect(ruleSection(gemini.systemInstruction)).toBe(ruleSection(nvidia[0].content));
    expect(JSON.parse(gemini.contents.at(-1)!.parts[0].text)).toEqual(JSON.parse(nvidia[1].content));
    expect(gemini.contents[0].parts[0].text).toBe('先打开官网');
    expect(nvidia[0].content).toContain('用户: 先打开官网');
    expect(gemini.systemInstruction).toContain('[Agent 记忆]');
    expect(nvidia[0].content).toContain('[Agent 记忆]');
  });

  it('exposes the same browser wait and page-content capabilities to both providers', () => {
    const gemini = buildGeminiAgentPromptPayload({
      task: '检查当前网页',
      step: 1,
      history: [],
      observation: {},
    });
    const geminiToolNames = gemini.tools[0].functionDeclarations.map(tool => tool.name);
    const nvidia = buildNvidiaTaskMessages({
      task: '检查当前网页',
      step: 1,
      history: [],
      observation: {},
    });

    expect(geminiToolNames).toContain('wait');
    expect(geminiToolNames).toContain('get_page_content');
    expect(nvidia[0].content).toContain('wait(seconds)');
    expect(nvidia[0].content).toContain('get_page_content()');
  });

  it('selects Gemini base tool schemas dynamically by task', () => {
    const chatTools = selectGeminiToolNames({ task: '你好，介绍一下你自己' });
    const webTools = selectGeminiToolNames({ task: '查询今天苏州天气' });
    const codeTools = selectGeminiToolNames({ task: '检查项目代码并运行测试' });
    const imageTools = selectGeminiToolNames({ task: '分析这张图片\n[附件]\n- 图片: /tmp/example.png' });
    const gitTools = selectGeminiToolNames({ task: '拉取最新' });

    expect([...chatTools].sort()).toEqual(['ask_user', 'finish', 'notify_user', 'web_search']);
    expect(webTools.has('web_search')).toBe(true);
    expect(webTools.has('navigate')).toBe(true);
    expect(webTools.has('read_file')).toBe(false);
    expect(codeTools.has('read_file')).toBe(true);
    expect(codeTools.has('codegraph_query')).toBe(true);
    expect(codeTools.has('run_safe')).toBe(true);
    expect(codeTools.has('web_search')).toBe(true);
    expect(codeTools.has('navigate')).toBe(false);
    expect(imageTools.has('image_analyze')).toBe(true);
    expect(imageTools.has('run_safe')).toBe(false);
    expect(gitTools.has('run_safe')).toBe(true);
    expect(gitTools.has('read_file')).toBe(false);
    expect(gitTools.has('web_search')).toBe(true);
    expect(gitTools.has('navigate')).toBe(false);
  });

  it('keeps web_search as a lightweight fallback for uncategorized current-information questions', () => {
    const tools = selectGeminiToolNames({ task: 'kimi为什么从英伟达模型nim里拿掉了' });

    expect(tools.has('web_search')).toBe(true);
    expect(tools.has('navigate')).toBe(false);
    expect(tools.has('finish')).toBe(true);
  });

  it('removes corrupted assistant echoes and their dangling user turns from conversation history', () => {
    const sanitized = sanitizeConversationHistory([
      { role: 'user', content: 'kimi为什么从英伟达模型nim里拿掉了' },
      { role: 'assistant', content: 'kimi为什么从英伟达模型nim里拿掉了' },
      { role: 'assistant', content: 'kimi为什么从英伟达模型nim里拿掉了' },
      { role: 'user', content: '保留这个有效问题' },
      { role: 'assistant', content: '这是有效回答' },
    ]);

    expect(sanitized).toEqual([
      { role: 'user', content: '保留这个有效问题' },
      { role: 'assistant', content: '这是有效回答' },
    ]);
  });

  it('keeps a new Gemini task isolated from corrupted previous turns', () => {
    const payload = buildGeminiAgentPromptPayload({
      task: '今天天气怎么样',
      step: 1,
      history: [],
      observation: {},
      conversationHistory: [
        { role: 'user', content: 'kimi为什么从英伟达模型nim里拿掉了' },
        { role: 'assistant', content: 'kimi为什么从英伟达模型nim里拿掉了' },
        { role: 'assistant', content: 'kimi为什么从英伟达模型nim里拿掉了' },
      ],
    });
    const taskPayload = JSON.parse(payload.contents.at(-1).parts[0].text);

    expect(payload.contents).toHaveLength(1);
    expect(taskPayload.task).toBe('今天天气怎么样');
    expect(payload.systemInstruction).toContain('task 是本轮唯一目标');
  });

  it('does not let unrelated conversation history activate tools for a new explicit task', () => {
    const tools = selectGeminiToolNames({
      task: '你好',
      conversationHistory: [
        { role: 'user', content: '检查项目文件并运行测试' },
        { role: 'assistant', content: '已完成' },
      ],
    });

    expect(tools.has('read_file')).toBe(false);
    expect(tools.has('run_safe')).toBe(false);
  });

  it('keeps Gemini tool groups loaded after they appear in execution history', () => {
    const selected = selectGeminiToolNames({
      task: '继续',
      history: [
        { action: { tool: 'browser', type: 'navigate' } },
        { action: { tool: 'fs', type: 'read_file' } },
      ],
    });

    expect(selected.has('navigate')).toBe(true);
    expect(selected.has('web_search')).toBe(true);
    expect(selected.has('read_file')).toBe(true);
    expect(selected.has('codegraph_query')).toBe(true);
  });

  it('bounds prompt history count and individual result size', () => {
    const compacted = compactAgentHistory(
      Array.from({ length: 9 }, (_, index) => ({
        step: index + 1,
        rationale: `step ${index + 1}`,
        action: { tool: 'browser', type: 'get_page_content' },
        result: 'x'.repeat(5000),
      })),
    );

    expect(compacted).toHaveLength(6);
    expect(compacted[0].step).toBe(4);
    expect(compacted[0].result).toContain('[提取摘要：原始 5000 字符]');
    expect(compacted[0].result.length).toBeLessThan(4100);
  });

  it('extracts task-relevant evidence from every joined source', () => {
    const result = [
      `http_fetch https://example.com/a:\n${'导航文本。'.repeat(200)}2022年 Alpha 指标达到100亿元，同比增长5%。`,
      `http_fetch https://example.com/b:\n${'页面说明。'.repeat(200)}2023年 Beta 指标达到220亿元，同比增长8%。`,
      `http_fetch https://example.com/c:\n${'版权信息。'.repeat(200)}2024年 Gamma 指标达到360亿元，同比增长12%。`,
    ].join('\n\n---\n\n');

    const compacted = compactToolResult({
      result,
      action: { tool: 'browser', type: 'http_fetch', url: 'https://example.com/a' },
      task: '比较 Alpha、Beta、Gamma 近三年指标增长情况',
      limit: 1500,
    });

    expect(compacted.length).toBeLessThanOrEqual(1500);
    expect(compacted).toContain('https://example.com/a');
    expect(compacted).toContain('2022年 Alpha 指标达到100亿元');
    expect(compacted).toContain('https://example.com/b');
    expect(compacted).toContain('2023年 Beta 指标达到220亿元');
    expect(compacted).toContain('https://example.com/c');
    expect(compacted).toContain('2024年 Gamma 指标达到360亿元');
  });

  it('passes task-aware extracted history to every provider prompt', () => {
    const longResult = [
      `http_fetch https://example.com/first:\n${'无关内容。'.repeat(1000)}第一来源关键结论 11%。`,
      `http_fetch https://example.com/second:\n${'其他内容。'.repeat(1000)}第二来源关键结论 22%。`,
    ].join('\n\n---\n\n');
    const context = {
      task: '提取第一来源和第二来源关键结论',
      step: 2,
      history: [{
        step: 1,
        action: { tool: 'browser', type: 'http_fetch', url: 'https://example.com/first' },
        result: longResult,
      }],
      observation: {},
    };
    const gemini = JSON.parse(buildGeminiTaskMessages(context).contents.at(-1)!.parts[0].text);
    const nvidia = JSON.parse(buildNvidiaTaskMessages(context)[1].content);

    for (const payload of [gemini, nvidia]) {
      expect(payload.history[0].result).toContain('https://example.com/first');
      expect(payload.history[0].result).toContain('第一来源关键结论 11%');
      expect(payload.history[0].result).toContain('https://example.com/second');
      expect(payload.history[0].result).toContain('第二来源关键结论 22%');
    }
  });
});
