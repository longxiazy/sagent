import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveHealthySnapshot } from '../agent/core/checkpoint.ts';
import { resolveCheckpointSeed } from '../routes/agent-run-request.ts';
import type { AgentStep } from '../agent/core/contracts.ts';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-rollback-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeHistory(steps: number[]): AgentStep[] {
  return steps.map(s => ({
    step: s,
    rationale: `step ${s} rationale`,
    action: { tool: 'browser', type: 'click', elementId: `el-${s}` },
    result: `step ${s} result`,
  }));
}

describe('resolveCheckpointSeed: rollback history correctness', () => {
  it('rollback to step 3 loads step 2 snapshot, starts from step 3', async () => {
    const runId = 'run_rollback_3';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 1, history: makeHistory([1]), state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: makeHistory([1, 2]), state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 3, history: makeHistory([1, 2, 3]), state: null, result: 'ok' });

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(tmpDir, {
      runId,
      step: 3,
    });

    // 应从 step 3 开始（不是 step 4）
    expect(checkpointInitialStep).toBe(3);
    // history 应只包含 step 1, 2 的结果（step 2 的快照）
    expect(checkpointInitialHistory).toHaveLength(2);
    expect(checkpointInitialHistory[0].step).toBe(1);
    expect(checkpointInitialHistory[1].step).toBe(2);
  });

  it('rollback to step 1 with no prior snapshot starts fresh', async () => {
    const runId = 'run_rollback_1';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 1, history: makeHistory([1]), state: null, result: 'ok' });

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(tmpDir, {
      runId,
      step: 1,
    });

    // 无 step 0 快照 → 从 step 1 开始，空 history
    expect(checkpointInitialStep).toBe(1);
    expect(checkpointInitialHistory).toEqual([]);
  });

  it('rollback to step 5 loads step 4 snapshot', async () => {
    const runId = 'run_rollback_5';
    for (let s = 1; s <= 5; s++) {
      await saveHealthySnapshot({ dir: tmpDir, runId, step: s, history: makeHistory([1, 2, 3, 4, 5].slice(0, s)), state: null, result: 'ok' });
    }

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(tmpDir, {
      runId,
      step: 5,
    });

    expect(checkpointInitialStep).toBe(5);
    expect(checkpointInitialHistory).toHaveLength(4);
    expect(checkpointInitialHistory.map((h: any) => h.step)).toEqual([1, 2, 3, 4]);
  });

  it('no fromCheckpoint returns undefined', async () => {
    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(tmpDir, null);
    expect(checkpointInitialStep).toBeUndefined();
    expect(checkpointInitialHistory).toBeUndefined();
  });
});
