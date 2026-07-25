import { describe, expect, it } from 'vitest';
import { createAgentRunStore } from '../helpers/run-store.ts';

describe('agent run store', () => {
  it('assigns a monotonic sequence to every event', () => {
    const store = createAgentRunStore();
    const run = store.createRun({}, 1, 'run_sequence', 7);

    const first = store.addEvent(run.runId, { type: 'status', status: 'running' });
    const second = store.addEvent(run.runId, { type: 'notification', level: 'info', message: 'next' });

    expect(first.seq).toBe(7);
    expect(second.seq).toBe(8);
    expect(run.nextEventSeq).toBe(9);
  });

  it('caps in-memory events while preserving the global sequence', () => {
    const store = createAgentRunStore({ maxEvents: 2 });
    const run = store.createRun({}, 1, 'run_event_cap');

    for (let index = 0; index < 4; index += 1) {
      store.addEvent(run.runId, { type: 'notification', level: 'info', message: String(index) });
    }

    expect(run.events.map(event => event.seq)).toEqual([3, 4]);
    expect(run.nextEventSeq).toBe(5);
  });

  it('atomically reserves the single active run slot', async () => {
    const store = createAgentRunStore();

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => store.tryCreateRun({ task: 'first' }, 1, 'run_first')),
      Promise.resolve().then(() => store.tryCreateRun({ task: 'second' }, 2, 'run_second')),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if ('activeRun' in first || 'run' in second) throw new Error('unexpected lock acquisition result');
    expect(first.run.status).toBe('starting');
    expect(second.activeRun).toBe(first.run);
    expect(store.getRun('run_second')).toBeNull();
  });

  it('does not release the run slot until cancelling cleanup finishes', () => {
    const store = createAgentRunStore();
    const acquired = store.tryCreateRun({}, 1, 'run_cancelling');
    if (!acquired.ok) throw new Error('expected initial lock acquisition');

    store.cancelRun(acquired.run.runId);
    const blocked = store.tryCreateRun({}, 2, 'run_blocked');
    expect(blocked.ok).toBe(false);

    store.closeRun(acquired.run.runId);
    const next = store.tryCreateRun({}, 3, 'run_next');
    expect(next.ok).toBe(true);
  });

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

  it('does not retain completed private runs in memory', () => {
    const store = createAgentRunStore();
    const run = store.createRun({ privateMode: true }, 1, 'run_private_memory');
    store.addEvent(run.runId, { type: 'notification', level: 'info', message: 'secret' });

    store.closeRun(run.runId, 'completed');

    expect(run.events).toEqual([]);
    expect(store.getRun(run.runId)).toBeNull();
  });

  it('rejects invalid state transitions', () => {
    const store = createAgentRunStore();
    const run = store.createRun({}, 1, 'run_invalid');
    store.closeRun(run.runId, 'completed');

    expect(() => store.transitionRun(run.runId, 'running')).toThrow('非法 Run 状态迁移');
  });
});
