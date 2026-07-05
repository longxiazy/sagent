import { describe, expect, it } from 'vitest';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';

describe('Core action normalization', () => {
  it('normalizes answer aliases to finish actions', () => {
    const result = normalizeDesktopAgentDecision({
      rationale: '直接回答',
      action: {
        type: 'answer',
        content: '可以直接回答',
      },
    });

    expect(result.action).toEqual({
      tool: 'core',
      type: 'finish',
      answer: '可以直接回答',
    });
  });
});
