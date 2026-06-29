import { describe, expect, it } from 'vitest';
import { buildActualContextEstimate } from '../client/src/utils/context-usage.js';

describe('context usage', () => {
  it('builds an actual first-step context estimate from model_plan usage', () => {
    const estimate = {
      source: 'server_actual_prompt',
      max: { modelId: 'model-a', windowTokens: 10_000 },
      modelEstimates: [
        { modelId: 'model-a', windowTokens: 10_000, promptPreview: { modelId: 'model-a', text: 'prompt a' } },
        { modelId: 'model-b', windowTokens: 20_000, promptPreview: { modelId: 'model-b', text: 'prompt b' } },
      ],
    };
    const actual = buildActualContextEstimate([
      { type: 'model_plan', stage: 'thinking', step: 1, model: 'model-a' },
      { type: 'model_plan', stage: 'success', step: 1, model: 'model-a', usage: { prompt_tokens: 5_000, completion_tokens: 50 } },
      { type: 'model_plan', stage: 'success', step: 1, model: 'model-b', usage: { prompt_tokens: 6_000, completion_tokens: 50 } },
      { type: 'model_plan', stage: 'success', step: 2, model: 'model-a', usage: { prompt_tokens: 9_000, completion_tokens: 50 } },
    ], estimate);

    expect(actual.source).toBe('actual_prompt_usage');
    expect(actual.usedTokens).toBe(5_000);
    expect(actual.percent).toBe(50);
    expect(actual.modelCount).toBe(2);
    expect(actual.average.percent).toBe(40);
    expect(actual.promptPreview.text).toBe('prompt a');
  });

  it('returns null until prompt usage is available', () => {
    expect(buildActualContextEstimate([
      { type: 'model_plan', stage: 'thinking', step: 1, model: 'model-a' },
    ], { max: { windowTokens: 10_000 } })).toBeNull();
  });
});
