import { describe, expect, it } from 'vitest';
import {
  buildModelContextEstimate,
  estimateTextTokens,
  formatTokenCount,
  inferContextWindow,
  summarizeContextEstimates,
} from '../agent/core/context-estimate.ts';

describe('context estimate', () => {
  it('infers common context windows from model ids', () => {
    expect(inferContextWindow('deepseek-ai/deepseek-v4-flash')).toBe(128_000);
    expect(inferContextWindow('google/gemini-2.5-pro')).toBe(1_000_000);
  });

  it('uses explicit model metadata before id heuristics', () => {
    expect(inferContextWindow('unknown/model', { context_length: 64_000 })).toBe(64_000);
  });

  it('estimates mixed language text tokens', () => {
    expect(estimateTextTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTextTokens('你好，世界')).toBeGreaterThan(0);
  });

  it('formats token counts as exact integers', () => {
    expect(formatTokenCount(2634)).toBe('2634');
    expect(formatTokenCount(128_000)).toBe('128000');
  });

  it('counts the actual provider planning payload instead of a fixed frontend overhead', () => {
    const base = buildModelContextEstimate({
      modelId: 'deepseek-ai/deepseek-v4-flash',
      modelInfo: { id: 'deepseek-ai/deepseek-v4-flash' },
      providerName: 'openai-compat',
      task: 'read the repo',
      systemPrompt: '',
      conversationHistory: [],
    });

    const withMemory = buildModelContextEstimate({
      modelId: 'deepseek-ai/deepseek-v4-flash',
      modelInfo: { id: 'deepseek-ai/deepseek-v4-flash' },
      providerName: 'openai-compat',
      task: 'read the repo',
      systemPrompt: 'project memory '.repeat(200),
      conversationHistory: [{ role: 'user', content: 'previous context' }],
    });

    expect(withMemory.usedTokens).toBeGreaterThan(base.usedTokens);
  });

  it('includes the first planning prompt preview used for the estimate', () => {
    const estimate = buildModelContextEstimate({
      modelId: 'deepseek-ai/deepseek-v4-flash',
      modelInfo: { id: 'deepseek-ai/deepseek-v4-flash' },
      providerName: 'openai-compat',
      task: 'inspect the prompt',
      systemPrompt: 'remember this project',
      conversationHistory: [{ role: 'user', content: 'previous context' }],
    });

    expect(estimate.promptPreview.modelId).toBe('deepseek-ai/deepseek-v4-flash');
    expect(estimate.promptPreview.usedTokens).toBe(estimate.usedTokens);
    expect(estimate.promptPreview.text).toContain('inspect the prompt');
    expect(estimate.promptPreview.text).toContain('previous context');
    expect(estimate.promptPreview.text).toContain('remember this project');
  });

  it('reports max and average usage for multi-model selections', () => {
    const small = buildModelContextEstimate({
      modelId: 'small-model',
      modelInfo: { context_length: 8_000 },
      providerName: 'openai-compat',
      task: 'x'.repeat(20_000),
      systemPrompt: '',
      conversationHistory: [],
    });
    const large = buildModelContextEstimate({
      modelId: 'google/gemini-2.5-pro',
      modelInfo: null,
      providerName: 'gemini',
      task: 'x'.repeat(20_000),
      systemPrompt: '',
      conversationHistory: [],
    });
    const estimate = summarizeContextEstimates([small, large]);

    expect(estimate.modelCount).toBe(2);
    expect(estimate.max.modelId).toBe('small-model');
    expect(estimate.max.promptPreview).toBeUndefined();
    expect(estimate.promptPreview.modelId).toBe('small-model');
    expect(estimate.modelEstimates.every(item => item.promptPreview == null)).toBe(true);
    expect(estimate.percent).toBeGreaterThan(estimate.average.percent);
    expect(['warning', 'danger']).toContain(estimate.risk);
  });
});
