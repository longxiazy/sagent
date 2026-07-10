import { describe, expect, it } from 'vitest';
import { createAgentRunStore } from '../helpers/run-store.ts';

describe('agent run store', () => {
  it('keeps cancelling runs active until cleanup finishes', () => {
    const store = createAgentRunStore();
    const runA = store.createRun({}, 1, 'run_a');
    const runB = store.createRun({}, 2, 'run_b');
    const runC = store.createRun({}, 3, 'run_c');

    store.cancelRun(runB.runId);
    store.closeRun(runC.runId);

    expect(runB.status).toBe('cancelling');
    expect(store.getActiveRuns().map(run => run.runId)).toEqual([runA.runId, runB.runId]);
    expect(store.getActiveRun()?.runId).toBe(runA.runId);
    expect(store.getRunningRuns().map(run => run.runId)).toEqual([runA.runId, runB.runId]);

    store.closeRun(runB.runId);
    expect(runB.status).toBe('cancelled');
    expect(store.getActiveRuns().map(run => run.runId)).toEqual([runA.runId]);
  });

  it('supports explicit approval waiting transitions', () => {
    const store = createAgentRunStore();
    const run = store.createRun({}, 1, 'run_waiting');

    store.transitionRun(run.runId, 'waiting_approval');
    expect(run.status).toBe('waiting_approval');
    expect(store.getActiveRun()).toBe(run);

    store.transitionRun(run.runId, 'running');
    store.closeRun(run.runId, 'completed');
    expect(run.status).toBe('completed');
    expect(store.getActiveRun()).toBeNull();
  });

  it('rejects invalid state transitions', () => {
    const store = createAgentRunStore();
    const run = store.createRun({}, 1, 'run_invalid');
    store.closeRun(run.runId, 'completed');

    expect(() => store.transitionRun(run.runId, 'running')).toThrow('非法 Run 状态迁移');
  });
});
