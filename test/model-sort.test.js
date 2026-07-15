import { describe, expect, it } from 'vitest';
import { modelGreetingScore, modelPrice, modelSpeed, sortModels } from '../client/src/utils/model-sort.js';

const models = [
  { id: 'zeta', label: 'Zeta', updated: '2025-01-01', pricePerMillionTokens: 2, latencyMs: 800 },
  { id: 'alpha', label: 'Alpha 10', updated: '2026-01-01', pricePerMillionTokens: 1, latencyMs: 200 },
  { id: 'alpha-2', label: 'Alpha 2' },
];

describe('model sorting', () => {
  it('sorts globally by the selected metric without mutating the input', () => {
    expect(sortModels(models, 'name').map(model => model.id)).toEqual(['alpha-2', 'alpha', 'zeta']);
    expect(sortModels(models, 'updated').map(model => model.id)).toEqual(['alpha', 'zeta', 'alpha-2']);
    expect(sortModels(models, 'price').map(model => model.id)).toEqual(['alpha', 'zeta', 'alpha-2']);
    expect(sortModels(models, 'speed').map(model => model.id)).toEqual(['alpha', 'zeta', 'alpha-2']);
    expect(models.map(model => model.id)).toEqual(['zeta', 'alpha', 'alpha-2']);
  });

  it('always places favorites first and supports recent usage', () => {
    expect(sortModels(models, 'name', { favoriteIds: ['zeta'] }).map(model => model.id)[0]).toBe('zeta');
    expect(sortModels(models, 'recent', { recentById: { zeta: 10, alpha: 30 } }).map(model => model.id)[0]).toBe('alpha');
  });

  it('reads common nested price and speed fields', () => {
    expect(modelPrice({ pricing: { input: 1, output: 3 } })).toBe(2);
    expect(modelSpeed({ tokens_per_second: 42 })).toBe(42);
    expect(modelSpeed({ time_to_first_token_ms: 250 })).toBe(4);
  });

  it('sorts greeting scores descending, using benchmark latency for ties', () => {
    const greetingModels = [
      { id: 'unscored' },
      { id: 'slow-perfect', greetingScore: 100, greetingAverageLatencyMs: 900 },
      { id: 'failed', greetingScore: 0 },
      { id: 'fast-perfect', greetingScore: 100, greetingAverageLatencyMs: 300 },
      { id: 'partial', greetingScore: 80, greetingAverageLatencyMs: 100 },
    ];

    expect(sortModels(greetingModels, 'greeting').map(model => model.id)).toEqual([
      'fast-perfect',
      'slow-perfect',
      'partial',
      'failed',
      'unscored',
    ]);
    expect(modelGreetingScore({ greeting_score: 0 })).toBe(0);
  });
});
