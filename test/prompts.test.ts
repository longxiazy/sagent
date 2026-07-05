import { describe, expect, it } from 'vitest';
import { buildGeminiTaskMessages, buildNvidiaTaskMessages } from '../agent/core/prompts.ts';
import { estimatePayloadTokens } from '../agent/core/context-estimate.ts';

describe('agent prompts', () => {
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
});
