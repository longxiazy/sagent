import { describe, expect, it } from 'vitest';
import { createAgentRunStore } from '../helpers/run-store.ts';

describe('agent run store', () => {
  it('lists only active non-cancelled runs', () => {
    const store = createAgentRunStore();
    const runA = store.createRun({}, 1, 'run_a');
    const runB = store.createRun({}, 2, 'run_b');
    const runC = store.createRun({}, 3, 'run_c');

    store.cancelRun(runB.runId);
    store.closeRun(runC.runId);

    expect(store.getActiveRuns().map((run: any) => run.runId)).toEqual([runA.runId]);
    expect(store.getActiveRun()?.runId).toBe(runA.runId);
    expect(store.getRunningRuns().map((run: any) => run.runId)).toEqual([runA.runId, runB.runId]);
  });
});
