import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  saveHealthySnapshot,
  saveFailedSnapshot,
  loadLatestHealthySnapshot,
  listSessionCheckpoints,
  clearSessionCheckpoints,
  KEEP_HEALTHY,
} from '../agent/core/session-checkpoint.js';
import { runAgentRuntime } from '../agent/core/runtime.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-checkpoint-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeHistory(steps) {
  return steps.map(s => ({
    step: s,
    rationale: `step ${s} rationale`,
    action: { type: 'click', elementId: `el-${s}` },
    result: `step ${s} result`,
  }));
}

// ─── session-checkpoint module tests ───

describe('saveHealthySnapshot + loadLatestHealthySnapshot', () => {
  it('writes snapshot to disk and loads it back', async () => {
    const runId = 'run_test1';
    const history = makeHistory([1, 2]);
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history, state: null, result: 'ok' });

    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 2);
    expect(cp).not.toBeNull();
    expect(cp.step).toBe(2);
    expect(cp.type).toBe('healthy');
    expect(cp.history).toHaveLength(2);
    expect(cp.history[0].step).toBe(1);
    expect(cp.history[1].step).toBe(2);
  });

  it('loads the latest snapshot <= upToStep', async () => {
    const runId = 'run_test2';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: makeHistory([1, 2]), state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 4, history: makeHistory([1, 2, 3, 4]), state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 6, history: makeHistory([1, 2, 3, 4, 5, 6]), state: null, result: 'ok' });

    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 5);
    expect(cp).not.toBeNull();
    expect(cp.step).toBe(4);

    const cp6 = await loadLatestHealthySnapshot(tmpDir, runId, 6);
    expect(cp6.step).toBe(6);
  });

  it('returns null when no snapshot exists', async () => {
    const cp = await loadLatestHealthySnapshot(tmpDir, 'run_nonexist', 5);
    expect(cp).toBeNull();
  });
});

describe('snapshot pruning', () => {
  it('keeps only KEEP_HEALTHY most recent snapshots', async () => {
    const runId = 'run_prune';
    // Save more than KEEP_HEALTHY snapshots
    for (let s = 1; s <= 40; s++) {
      await saveHealthySnapshot({ dir: tmpDir, runId, step: s, history: makeHistory([s]), state: null, result: 'ok' });
    }

    const cpDir = path.join(tmpDir, 'session-checkpoints', runId);
    const files = await fs.readdir(cpDir);
    const healthyFiles = files.filter(f => f.startsWith('session-healthy-') && f.endsWith('.json'));
    expect(healthyFiles).toHaveLength(KEEP_HEALTHY);

    const steps = healthyFiles.map(f => {
      const m = f.match(/session-healthy-(\d+)\.json$/);
      return m ? parseInt(m[1]) : 0;
    }).sort((a, b) => a - b);
    // Should keep the latest KEEP_HEALTHY steps
    expect(steps[0]).toBe(40 - KEEP_HEALTHY + 1);
    expect(steps[steps.length - 1]).toBe(40);
  });
});

describe('sanitizeState', () => {
  it('removes sensitive fields from snapshot state', async () => {
    const runId = 'run_sanitize';
    const state = {
      chromium: '/path/to/chrome',
      browserCandidatePaths: ['/a', '/b'],
      onEvent: () => {},
      browserSession: { page: {} },
      observeDesktop: true,
      customField: 'keep this',
    };
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: [], state, result: 'ok' });

    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 2);
    expect(cp.state.chromium).toBeUndefined();
    expect(cp.state.browserCandidatePaths).toBeUndefined();
    expect(cp.state.onEvent).toBeUndefined();
    expect(cp.state.browserSession).toBeUndefined();
    expect(cp.state.observeDesktop).toBeUndefined();
    expect(cp.state.browserSessionActive).toBe(true);
    expect(cp.state.customField).toBe('keep this');
  });
});

describe('listSessionCheckpoints', () => {
  it('lists both healthy and failed checkpoints sorted by step', async () => {
    const runId = 'run_list';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: [], state: null, result: 'ok' });
    await saveFailedSnapshot({ dir: tmpDir, runId, step: 5, history: [], error: new Error('boom'), state: null });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 4, history: [], state: null, result: 'ok' });

    const list = await listSessionCheckpoints(tmpDir, runId);
    expect(list).toHaveLength(3);
    expect(list[0].step).toBe(2);
    expect(list[0].type).toBe('healthy');
    expect(list[1].step).toBe(4);
    expect(list[2].step).toBe(5);
    expect(list[2].type).toBe('failed');
    expect(list[2].error).toBe('boom');
  });
});

describe('clearSessionCheckpoints', () => {
  it('removes the entire checkpoint directory', async () => {
    const runId = 'run_clear';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: [], state: null, result: 'ok' });

    const cpDir = path.join(tmpDir, 'session-checkpoints', runId);
    await fs.access(cpDir);

    await clearSessionCheckpoints(tmpDir, runId);
    await expect(fs.access(cpDir)).rejects.toThrow();
  });
});

// ─── runtime integration tests ───

function noop() {}
const events = () => {
  const log = [];
  return { log, onEvent: e => log.push(e) };
};

describe('runtime: session checkpoint integration', () => {
  it('saves snapshots at interval steps', async () => {
    const runId = 'run_rt2';
    const runRecord = { runId, pendingRollback: null };
    const { log: evtLog, onEvent } = events();
    const cancelSignal = new AbortController().signal;

    let stepCount = 0;
    await runAgentRuntime({
      task: 'test',
      maxSteps: 7,
      onEvent,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord,
      initialize: noop,
      observe: noop,
      decide: () => {
        stepCount++;
        if (stepCount >= 7) {
          return { action: { type: 'finish', answer: 'all done' }, rationale: 'enough' };
        }
        return { action: { type: 'click', elementId: 'btn' }, rationale: 'go' };
      },
      authorize: noop,
      execute: () => 'executed',
      cleanup: noop,
    });

    // HEALTH_CHECKPOINT_INTERVAL = 1, every step gets a snapshot (including the finish step)
    const cpEvents = evtLog.filter(e => e.type === 'session_checkpoint');
    expect(cpEvents.map(e => e.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Snapshot save is fire-and-forget — wait for disk writes to complete
    await new Promise(r => setTimeout(r, 200));
    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 6);
    expect(cp).not.toBeNull();
    expect(cp.history.length).toBeGreaterThanOrEqual(5);
  });

  it('manual rollback restores snapshot history and continues', async () => {
    const runId = 'run_rt3';
    const cancelSignal = new AbortController().signal;

    // First run: create checkpoints up to step 6
    let stepCount = 0;
    await runAgentRuntime({
      task: 'test',
      maxSteps: 7,
      onEvent: noop,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord: { runId, pendingRollback: null },
      initialize: noop,
      observe: noop,
      decide: () => {
        stepCount++;
        if (stepCount >= 7) {
          return { action: { type: 'finish', answer: 'done' }, rationale: 'enough' };
        }
        return { action: { type: 'click', elementId: 'btn' }, rationale: 'go' };
      },
      authorize: noop,
      execute: () => 'executed',
      cleanup: noop,
    });

    // Snapshot save is fire-and-forget — poll until step 2 snapshot is written
    let snap2 = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 100));
      snap2 = await loadLatestHealthySnapshot(tmpDir, runId, 2);
      if (snap2) break;
    }
    expect(snap2).not.toBeNull();
    expect(snap2.step).toBe(2);

    // Second run: rollback to step 2
    const runRecord2 = { runId, pendingRollback: 2 };
    const { log: evtLog2, onEvent: onEvent2 } = events();
    stepCount = 0;

    const result = await runAgentRuntime({
      task: 'test',
      maxSteps: 8,
      onEvent: onEvent2,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord: runRecord2,
      initialStep: 1,
      initialHistory: makeHistory([1, 2, 3, 4]),
      initialize: noop,
      observe: noop,
      decide: () => {
        stepCount++;
        if (stepCount >= 3) {
          return { action: { type: 'finish', answer: 'rolled back' }, rationale: 'done' };
        }
        return { action: { type: 'click', elementId: 'btn' }, rationale: 'retry' };
      },
      authorize: noop,
      execute: () => 'executed',
      cleanup: noop,
    });

    const rollbackEvent = evtLog2.find(e => e.type === 'rollback');
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent.targetStep).toBe(2);
    expect(runRecord2.pendingRollback).toBeNull();
    expect(runRecord2.rolledBack).toBe(true);
    expect(result.answer).toBe('rolled back');
  });

  it('rollback to nonexistent snapshot clears pendingRollback and continues', async () => {
    const runId = 'run_rt4';
    const runRecord = { runId, pendingRollback: 99 };
    const { log: evtLog, onEvent } = events();
    const cancelSignal = new AbortController().signal;

    const result = await runAgentRuntime({
      task: 'test',
      maxSteps: 3,
      onEvent,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord,
      initialize: noop,
      observe: noop,
      decide: () => ({ action: { type: 'finish', answer: 'done' }, rationale: 'ok' }),
      authorize: noop,
      execute: noop,
      cleanup: noop,
    });

    expect(runRecord.pendingRollback).toBeNull();
    expect(evtLog.some(e => e.type === 'rollback')).toBe(false);
    // Runtime returns result, it doesn't emit 'done' event itself
    expect(result.answer).toBe('done');
    // Wait for fire-and-forget snapshot writes to complete
    await new Promise(r => setTimeout(r, 200));
  });
});
