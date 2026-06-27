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
});
