import { describe, expect, it, vi } from 'vitest';
import { createDesktopPlanner } from '../agent/desktop/planner/index.ts';

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

describe('race strategy batch scheduling', () => {
  // 让每个模型都停在未决状态，这样批次推进只可能由错峰定时器驱动。
  function pendingPlanner(events: any[], overrides: Record<string, any> = {}) {
    const started: string[] = [];
    const agentPlan = vi.fn(({ model }: { model: string }) => {
      started.push(model);
      return new Promise(() => {});
    });
    const planner = createDesktopPlanner({
      registry: { resolve: () => ({ agentPlan }) },
      modelConfig: [],
      blacklistedModels: new Set(),
      modelTimeoutMs: 60_000,
      batchSize: 1,
      staggerDelayMs: 10_000,
      ...overrides,
    });
    return { planner, started };
  }

  function runRace(planner: any, agentModels: string[], events: any[]) {
    // 不 await：race 只在有模型返回时才落定，这里所有模型都悬着。
    planner({
      model: agentModels[0],
      agentModels,
      strategy: 'race',
      cancelSignal: new AbortController().signal,
      onEvent: (event: any) => events.push(event),
      step: 1,
      task: 'test',
      history: [],
      observation: {},
    }).catch(() => {});
  }

  it('launches the next batch once the stagger delay elapses', async () => {
    vi.useFakeTimers();
    try {
      const events: any[] = [];
      const { planner, started } = pendingPlanner(events);
      runRace(planner, ['first-model', 'second-model'], events);
      await vi.advanceTimersByTimeAsync(0);

      // 首批立即启动，第二个模型此时只应处于排队态。
      expect(started).toEqual(['first-model']);
      expect(events.some(e => e.stage === 'pending' && e.model === 'second-model')).toBe(true);

      // 差一点到点：仍不应启动。
      await vi.advanceTimersByTimeAsync(9_999);
      expect(started).toEqual(['first-model']);

      // 到点后第二批必须启动——这正是此前缺失时间驱动而失效的行为。
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toEqual(['first-model', 'second-model']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps advancing across more than two batches', async () => {
    vi.useFakeTimers();
    try {
      const events: any[] = [];
      const { planner, started } = pendingPlanner(events);
      runRace(planner, ['m1', 'm2', 'm3'], events);
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(['m1']);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(started).toEqual(['m1', 'm2']);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(started).toEqual(['m1', 'm2', 'm3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('launches every model at once when the stagger delay is zero', async () => {
    vi.useFakeTimers();
    try {
      const events: any[] = [];
      const { planner, started } = pendingPlanner(events, { staggerDelayMs: 0 });
      runRace(planner, ['m1', 'm2', 'm3'], events);
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toEqual(['m1', 'm2', 'm3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the remaining wait when the whole batch fails', async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const agentPlan = vi.fn(({ model }: { model: string }) => {
        started.push(model);
        // 首个模型立即失败，后续模型悬停，便于观察续批时机。
        return model === 'doomed' ? Promise.reject(new Error('boom')) : new Promise(() => {});
      });
      const planner = createDesktopPlanner({
        registry: { resolve: () => ({ agentPlan }) },
        modelConfig: [],
        blacklistedModels: new Set(),
        modelTimeoutMs: 60_000,
        batchSize: 1,
        staggerDelayMs: 10_000,
      });

      planner({
        model: 'doomed',
        agentModels: ['doomed', 'backup'],
        strategy: 'race',
        cancelSignal: new AbortController().signal,
        step: 1,
        task: 'test',
        history: [],
        observation: {},
      }).catch(() => {});

      // 整批失败应立刻续批，而不是干等满 10s。
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(['doomed', 'backup']);

      // 且失败续批撤销了原定时器，不会在到点时重复推进。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(started).toEqual(['doomed', 'backup']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('desktop planner failure tracing', () => {
  it('keeps the sent prompt on the failed event when a single model times out', async () => {
    const sentMessages = [{ role: 'system', content: '协议' }, { role: 'user', content: '{"task":"test"}' }];
    const agentPlan = vi.fn(({ signal, onRequest }: { signal: AbortSignal; onRequest: (m: unknown[]) => void }) => {
      onRequest(sentMessages);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const events: any[] = [];
    const planner = createDesktopPlanner({
      registry: { resolve: () => ({ agentPlan }) },
      modelConfig: [],
      blacklistedModels: new Set(),
      modelTimeoutMs: 10,
    });

    await expect(planner({
      model: 'slow-model',
      agentModels: ['slow-model'],
      strategy: 'race',
      cancelSignal: new AbortController().signal,
      step: 1,
      task: 'test',
      history: [],
      observation: {},
      onEvent: (event: any) => events.push(event),
    })).rejects.toThrow('模型超时');

    // 超时步骤的 prompt 输入必须留痕，否则最需要复盘的步骤在 trace 里反而查不到请求原文。
    const failed = events.find(event => event.type === 'model_plan' && event.stage === 'failed');
    expect(failed?.requests).toEqual([sentMessages]);
  });

  it('omits requests when the model never got as far as sending one', async () => {
    const events: any[] = [];
    const planner = createDesktopPlanner({
      registry: { resolve: () => ({ agentPlan: () => Promise.reject(new Error('provider down')) }) },
      modelConfig: [],
      blacklistedModels: new Set(),
      modelTimeoutMs: 1_000,
    });

    await expect(planner({
      model: 'broken-model',
      agentModels: ['broken-model'],
      strategy: 'race',
      cancelSignal: new AbortController().signal,
      step: 1,
      task: 'test',
      history: [],
      observation: {},
      onEvent: (event: any) => events.push(event),
    })).rejects.toThrow('provider down');

    const failed = events.find(event => event.type === 'model_plan' && event.stage === 'failed');
    expect(failed).toBeTruthy();
    expect(failed.requests).toBeUndefined();
  });
});
