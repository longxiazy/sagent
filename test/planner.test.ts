import { describe, expect, it, vi } from 'vitest';
import { createJsonPlanner } from '../agent/core/planner.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';

function completion(content: unknown) {
  return {
    choices: [
      {
        message: {
          content: typeof content === 'string' ? content : JSON.stringify(content),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('createJsonPlanner', () => {
  it('retries once when a valid JSON action fails normalization', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(completion({
        rationale: '查看文件大小',
        action: { tool: 'fs', type: 'made_up_file_info', path: 'README.md' },
      }))
      .mockResolvedValueOnce(completion({
        rationale: '改用可用动作',
        action: { tool: 'fs', type: 'get_file_info', path: 'README.md' },
      }));

    const planner = createJsonPlanner({
      client: { chat: { completions: { create } } },
      buildMessages: () => [{ role: 'user', content: 'inspect file' }],
      normalizeDecision: normalizeDesktopAgentDecision,
    });

    const result = await planner({
      model: 'deepseek-ai/deepseek-v4-flash',
      task: 'inspect file',
      step: 1,
      history: [],
      observation: {},
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.action).toEqual({
      tool: 'fs',
      type: 'get_file_info',
      path: 'README.md',
    });
    expect(create.mock.calls[1][0].messages.at(-1).content).toContain('不要编造工具/动作名');
  });

  it('retries without default chat_template_kwargs when the provider rejects them', async () => {
    const err: any = new Error('Unrecognized request argument supplied: chat_template_kwargs');
    err.status = 400;
    const create = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(completion({
        rationale: '完成',
        action: { type: 'finish', answer: 'ok' },
      }));

    const planner = createJsonPlanner({
      client: { chat: { completions: { create } } },
      buildMessages: () => [{ role: 'user', content: 'inspect file' }],
      normalizeDecision: normalizeDesktopAgentDecision,
    });

    const result = await planner({
      model: 'deepseek-ai/deepseek-v4-flash',
      task: 'inspect file',
      step: 1,
      history: [],
      observation: {},
    });

    expect(result.action).toEqual({ tool: 'core', type: 'finish', answer: 'ok' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: 'high',
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty('chat_template_kwargs');
  });

  it('caps agent output tokens to fit small context windows', async () => {
    const create = vi.fn().mockResolvedValue(completion({
      rationale: '完成',
      action: { type: 'finish', answer: 'ok' },
    }));

    const planner = createJsonPlanner({
      client: { chat: { completions: { create } } },
      buildMessages: () => [{ role: 'user', content: 'x'.repeat(11_000) }],
      normalizeDecision: normalizeDesktopAgentDecision,
    });

    await planner({
      model: 'tiny-context-model',
      modelConfig: [{ id: 'tiny-context-model', contextWindow: 4096 }],
      task: 'inspect file',
      step: 1,
      history: [],
      observation: {},
    });

    expect(create.mock.calls[0][0].max_tokens).toBeLessThan(16_000);
    expect(create.mock.calls[0][0].max_tokens).toBeLessThanOrEqual(512);
  });

  it('retries with fewer output tokens when the provider reports a small context window', async () => {
    const err: any = new Error(
      "This model's maximum context length is 4096 tokens. However, you requested 19810 tokens (3810 in the messages, 16000 in the completion). Please reduce the length of the messages or completion.",
    );
    err.status = 400;
    const create = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(completion({
        rationale: '完成',
        action: { type: 'finish', answer: 'ok' },
      }));

    const planner = createJsonPlanner({
      client: { chat: { completions: { create } } },
      buildMessages: () => [{ role: 'user', content: 'inspect file' }],
      normalizeDecision: normalizeDesktopAgentDecision,
    });

    const result = await planner({
      model: 'unknown-small-model',
      task: 'inspect file',
      step: 1,
      history: [],
      observation: {},
    });

    expect(result.action).toEqual({ tool: 'core', type: 'finish', answer: 'ok' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].max_tokens).toBe(16_000);
    expect(create.mock.calls[1][0].max_tokens).toBe(158);
  });

  it('switches to compact messages when context retry would leave too few output tokens', async () => {
    const err: any = new Error(
      "This model's maximum context length is 4096 tokens. However, you requested 20084 tokens (4072 in the messages, 16012 in the completion). Please reduce the length of the messages or completion.",
    );
    err.status = 400;
    const create = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(completion({
        rationale: '完成',
        action: { type: 'finish', answer: 'ok' },
      }));

    const planner = createJsonPlanner({
      client: { chat: { completions: { create } } },
      buildMessages: () => [{ role: 'system', content: 'x'.repeat(15_000) }, { role: 'user', content: 'task' }],
      buildCompactMessages: () => [{ role: 'system', content: 'compact' }, { role: 'user', content: 'task' }],
      normalizeDecision: normalizeDesktopAgentDecision,
    });

    const result = await planner({
      model: 'unknown-small-model',
      task: 'inspect file',
      step: 1,
      history: [],
      observation: {},
    });

    expect(result.action).toEqual({ tool: 'core', type: 'finish', answer: 'ok' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].messages[0].content).toBe('compact');
    expect(create.mock.calls[1][0].max_tokens).toBeGreaterThanOrEqual(128);
    expect(create.mock.calls[1][0].max_tokens).toBeLessThan(4096);
  });

  it('fails locally when a small context model leaves no useful output budget and no compact prompt is available', async () => {
    const err: any = new Error(
      "This model's maximum context length is 4096 tokens. However, you requested 20084 tokens (4072 in the messages, 16012 in the completion). Please reduce the length of the messages or completion.",
    );
    err.status = 400;
    const create = vi.fn().mockRejectedValueOnce(err);

    const planner = createJsonPlanner({
      client: { chat: { completions: { create } } },
      buildMessages: () => [{ role: 'system', content: 'x'.repeat(15_000) }, { role: 'user', content: 'task' }],
      normalizeDecision: normalizeDesktopAgentDecision,
    });

    await expect(planner({
      model: 'unknown-small-model',
      task: 'inspect file',
      step: 1,
      history: [],
      observation: {},
    })).rejects.toThrow('模型上下文太小');

    expect(create).toHaveBeenCalledTimes(1);
  });
});
