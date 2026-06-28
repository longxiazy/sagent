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
    expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: 'high',
    });
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
    expect(create.mock.calls[0][0]).not.toHaveProperty('chat_template_kwargs');
  });

  it('passes explicit chat_template_kwargs through to completion requests', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });
    const provider = createOpenAICompatProvider({
      chat: { completions: { create } },
      models: { list: vi.fn() },
    });

    await provider.completionJson({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      top_p: 1,
      max_tokens: 100,
      chat_template_kwargs: { thinking: true, reasoning_effort: 'medium' },
      preserveReasoningContent: true,
    });

    expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: 'medium',
    });
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
    expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: 'high',
    });
    expect(res.writes.at(-1)).toBe('data: [DONE]\n\n');
    expect(res.ended).toBe(true);
  });

  it('retries without default chat_template_kwargs when a provider rejects them', async () => {
    const err: any = new Error('Unknown parameter: chat_template_kwargs');
    err.status = 400;
    const create = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' } }],
      });
    const provider = createOpenAICompatProvider({
      chat: { completions: { create } },
      models: { list: vi.fn() },
    });

    await provider.completionJson({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      top_p: 1,
      max_tokens: 100,
      preserveReasoningContent: true,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toHaveProperty('chat_template_kwargs');
    expect(create.mock.calls[1][0]).not.toHaveProperty('chat_template_kwargs');
  });
});
