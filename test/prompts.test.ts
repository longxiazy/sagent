import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGeminiTaskMessages, buildNvidiaTaskMessages, compactAgentHistory } from '../agent/core/prompts.ts';
import { estimatePayloadTokens } from '../agent/core/context-estimate.ts';

describe('agent prompts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(compacted[0].result).toContain('[结果已截断，共 5000 字符]');
    expect(compacted[0].result.length).toBeLessThan(4100);
  });
});
