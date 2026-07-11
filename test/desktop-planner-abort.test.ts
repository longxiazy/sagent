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
});
