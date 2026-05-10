import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { appendTraceEvent, listTraceRuns, readTraceEvents } from '../helpers/trace-store.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-trace-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('trace store', () => {
  it('appends and reads jsonl trace events', async () => {
    const runId = 'run_labc123_abcdef';
    await appendTraceEvent(tmpDir, runId, { type: 'status', message: 'starting' });
    await appendTraceEvent(tmpDir, runId, { type: 'done', answer: 'ok' });

    const events = await readTraceEvents(tmpDir, runId);
    expect(events).toEqual([
      { type: 'status', message: 'starting', runId },
      { type: 'done', answer: 'ok', runId },
    ]);
    expect(await listTraceRuns(tmpDir)).toEqual([runId]);
  });

  it('ignores invalid run ids', async () => {
    await appendTraceEvent(tmpDir, '../bad', { type: 'status' });
    expect(await readTraceEvents(tmpDir, '../bad')).toEqual([]);
    expect(await listTraceRuns(tmpDir)).toEqual([]);
  });
});
