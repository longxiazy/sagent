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
    vi.unstubAllEnvs();
  });

  it('provides detailed, valid NVIDIA JSON examples for every built-in action', () => {
    const lines = buildNvidiaActionExampleLines();
    const schemas = new Map(createModelTools({ includeIdeMcp: false, includeChromeMcp: false })
      .map(tool => [tool.name, tool.input_schema]));

    expect(lines.length).toBeGreaterThanOrEqual(schemas.size);
    for (const line of lines) {
      const example = JSON.parse(line);
      expect(example).toEqual(expect.objectContaining({
        rationale: expect.any(String),
        action: expect.any(Object),
      }));
      expect(example).not.toHaveProperty('rational');
      const schema = schemas.get(example.action.type);
      expect(schema, `missing tool schema for ${line}`).toBeDefined();
      for (const required of schema.required || []) {
        expect(Object.prototype.hasOwnProperty.call(example.action, required), `${line} is missing ${required}`).toBe(true);
      }
    }

    const conditional = buildNvidiaActionExampleLines({ ideEnabled: true, chromeEnabled: true });
    expect(lines.some(line => line.includes('ide_call_tool'))).toBe(false);
    expect(lines.some(line => line.includes('chrome_call_tool'))).toBe(false);
    expect(conditional.some(line => line.includes('ide_call_tool'))).toBe(true);
    expect(conditional.some(line => line.includes('chrome_call_tool'))).toBe(true);

    const readonlyTypes = buildNvidiaActionExampleLines({ readonly: true })
      .map(line => JSON.parse(line).action.type);
    expect(readonlyTypes.sort()).toEqual([
      'codegraph_query',
      'finish',
      'get_file_info',
      'image_analyze',
      'list_dir',
      'read_file',
      'search_files',
      'web_search',
    ].sort());
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
  });

  it('keeps Chrome and IDE MCP details lazy for unrelated tasks', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    vi.stubEnv('IDE_MCP_ENABLED', 'true');
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

    expect(weather[0].content).toContain('Chrome MCP 已启用但默认不展开');
    expect(weather[0].content).toContain('IDE MCP 已启用但默认不展开');
    expect(weather[0].content).not.toContain('Chrome DevTools 工具可用于');
    expect(weather[0].content).not.toContain('projectPath');
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

  it('omits inactive Chrome and IDE capabilities from Gemini prompts and tools', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    vi.stubEnv('IDE_MCP_ENABLED', 'true');
    const payload = buildGeminiAgentPromptPayload({
      task: '杭州今天天气怎么样？',
      step: 1,
      history: [],
      observation: {},
    });
    const toolNames = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(payload.systemInstruction).not.toContain('Chrome MCP');
    expect(payload.systemInstruction).not.toContain('IDE MCP');
    expect(toolNames).not.toContain('chrome_list_tools');
    expect(toolNames).not.toContain('chrome_call_tool');
    expect(toolNames).not.toContain('ide_list_tools');
    expect(toolNames).not.toContain('ide_call_tool');
  });

  it('loads Gemini Chrome and IDE capabilities when the task requires them', () => {
    vi.stubEnv('CHROME_MCP_ENABLED', 'true');
    vi.stubEnv('IDE_MCP_ENABLED', 'true');
    const payload = buildGeminiAgentPromptPayload({
      task: '用 Chrome DevTools 和 IntelliJ 检查页面及代码问题',
      step: 1,
      history: [],
      observation: {},
    });
    const toolNames = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(payload.systemInstruction).toContain('Chrome DevTools 工具可用于');
    expect(payload.systemInstruction).toContain('当 IDE MCP 已启用时');
    expect(toolNames).toContain('chrome_list_tools');
    expect(toolNames).toContain('chrome_call_tool');
    expect(toolNames).toContain('ide_list_tools');
    expect(toolNames).toContain('ide_call_tool');
  });

  it('keeps shared Gemini and NVIDIA agent rules semantically identical', () => {
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
    expect(payload.systemInstruction).toContain('task 字段是本轮唯一执行目标');
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

  it('keeps the complete readonly Gemini tool set for delegated analysis', () => {
    const payload = buildGeminiAgentPromptPayload({
      task: '分析这个问题',
      step: 1,
      history: [],
      observation: {},
    }, 'readonly');
    const names = payload.tools[0].functionDeclarations.map(tool => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'list_dir',
      'read_file',
      'get_file_info',
      'search_files',
      'web_search',
      'image_analyze',
      'codegraph_query',
      'finish',
    ]));
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
