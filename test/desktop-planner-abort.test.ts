import { describe, expect, it, vi } from 'vitest';
import { createDesktopPlanner } from '../agent/desktop/planner.ts';

describe('desktop planner abort propagation', () => {
  it('aborts the provider request when the model deadline expires', async () => {
    let providerSignal: AbortSignal | undefined;
    const agentPlan = vi.fn(({ signal }: { signal: AbortSignal }) => {
      providerSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const planner = createDesktopPlanner({
      registry: { resolve: () => ({ agentPlan }) },
      modelConfig: [],
      blacklistedModels: new Set(),
      modelTimeoutMs: 10,
    });

    await expect(planner({
      model: 'slow-model',
      agentModels: ['slow-model'],
      strategy: 'progressive',
      cancelSignal: new AbortController().signal,
      step: 1,
      task: 'test',
      history: [],
      observation: {},
    })).rejects.toThrow('模型超时');

    expect(agentPlan).toHaveBeenCalledTimes(1);
    expect(providerSignal?.aborted).toBe(true);
  });

  it('short-circuits vote mode as soon as any model returns finish', async () => {
    let slowSignal: AbortSignal | undefined;
    const agentPlan = vi.fn(({ model, signal }: { model: string; signal: AbortSignal }) => {
      if (model === 'tool-model') {
        return Promise.resolve({ rationale: '继续搜索', action: { tool: 'search', type: 'web_search', query: 'test' } });
      }
      if (model === 'finish-model') {
        return new Promise(resolve => setTimeout(() => resolve({
          rationale: '信息足够',
          action: { tool: 'core', type: 'finish', answer: 'done' },
        }), 10));
      }
      slowSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const events: any[] = [];
    const planner = createDesktopPlanner({
      registry: { resolve: () => ({ agentPlan }) },
      modelConfig: [],
      blacklistedModels: new Set(),
      modelTimeoutMs: 5_000,
    });

    const result: any = await planner({
      model: 'tool-model',
      agentModels: ['tool-model', 'finish-model', 'slow-model'],
      strategy: 'vote',
      cancelSignal: new AbortController().signal,
      onEvent: event => events.push(event),
      step: 1,
      task: 'test',
      history: [],
      observation: {},
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(result.action).toEqual({ tool: 'core', type: 'finish', answer: 'done' });
    expect(result.model).toBe('finish-model');
    expect(result).not.toHaveProperty('consensus');
    expect(slowSignal?.aborted).toBe(true);
    expect(events.some(event => event.stage === 'success' && event.model === 'tool-model')).toBe(true);
    expect(events.some(event => event.stage === 'winner' && event.model === 'finish-model' && event.finishShortCircuit)).toBe(true);
    expect(events.some(event => event.stage === 'cancelled' && event.model === 'slow-model')).toBe(true);
    expect(events.some(event => event.stage === 'consensus')).toBe(false);
  });

  it('keeps normal vote aggregation when no model returns finish', async () => {
    const agentPlan = vi.fn(({ model }: { model: string }) => Promise.resolve({
      rationale: model,
      action: model === 'search-model'
        ? { tool: 'search', type: 'web_search', query: 'test' }
        : { tool: 'browser', type: 'http_fetch', url: 'https://example.com' },
    }));
    const events: any[] = [];
    const planner = createDesktopPlanner({
      registry: { resolve: () => ({ agentPlan }) },
      modelConfig: [],
      blacklistedModels: new Set(),
      modelTimeoutMs: 5_000,
    });

    const result: any = await planner({
      model: 'search-model',
      agentModels: ['search-model', 'browser-model'],
      strategy: 'vote',
      cancelSignal: new AbortController().signal,
      onEvent: event => events.push(event),
      step: 1,
      task: 'test',
      history: [],
      observation: {},
    });

    expect(result.consensus.total).toBe(2);
    expect(events.some(event => event.stage === 'consensus')).toBe(true);
  });
});
