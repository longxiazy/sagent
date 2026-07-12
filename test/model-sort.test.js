import { describe, expect, it } from 'vitest';
import { modelPrice, modelSpeed, sortModels } from '../client/src/utils/model-sort.js';

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
});
