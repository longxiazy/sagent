import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatProvider } from '../agent/core/providers/openai-compat.ts';

function createMockRes() {
  return {
    headers: new Map<string, string>(),
    writes: [] as string[],
    ended: false,
    setHeader(name: string, value: string) {
      this.headers.set(name, value);
    },
    flushHeaders: vi.fn(),
    write(payload: string) {
      this.writes.push(payload);
    },
    end() {
      this.ended = true;
    },
  };
}

async function* streamChunks(chunks: any[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('OpenAICompatProvider reasoning content preservation', () => {
  it('prepends reasoning_content to non-streaming chat completion content when requested', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'chatcmpl-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          reasoning_content: '先分析问题',
          content: '最终回答',
        },
        finish_reason: 'stop',
      }],
    });
    const provider = createOpenAICompatProvider({
      chat: { completions: { create } },
      models: { list: vi.fn() },
    });

    const response = await provider.completionJson({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      top_p: 1,
      max_tokens: 100,
      preserveReasoningContent: true,
    });

    expect(response.choices[0].message.content).toBe('[Thinking / 推理过程]\n先分析问题\n\n最终回答');
  });

  it('leaves structured internal completion content unchanged by default', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          reasoning_content: '内部推理',
          content: '{"ok":true}',
        },
      }],
    });
    const provider = createOpenAICompatProvider({
      chat: { completions: { create } },
      models: { list: vi.fn() },
    });

    const response = await provider.completionJson({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'json' }],
      temperature: 0.1,
      top_p: 1,
      max_tokens: 100,
    });

    expect(response.choices[0].message.content).toBe('{"ok":true}');
  });

  it('streams reasoning_content as normal content with a reasoning header', async () => {
    const create = vi.fn().mockResolvedValue(streamChunks([
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: '先想' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: '清楚' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '最终' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '回答' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]));
    const provider = createOpenAICompatProvider({
      chat: { completions: { create } },
      models: { list: vi.fn() },
    });
    const res = createMockRes();

    await provider.completionStream({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      top_p: 1,
      max_tokens: 100,
      preserveReasoningContent: true,
      res: res as any,
    });

    const payloads = res.writes
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice('data: '.length)).choices[0].delta.content)
      .filter(Boolean)
      .join('');

    expect(payloads).toBe('[Thinking / 推理过程]\n先想清楚\n\n最终回答');
    expect(res.writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(res.ended).toBe(true);
  });
});
