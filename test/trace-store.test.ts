import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { appendTraceEvent, listTraceRuns, readTraceEvents } from '../helpers/trace-store.ts';
import { createAgentRunStore } from '../helpers/run-store.ts';
import { createBaseEventSender } from '../helpers/run-agent.ts';

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

  it('serializes rapid trace writes and flushes them in event order', async () => {
    const runId = 'run_trace_queue';
    const store = createAgentRunStore();
    const run = store.createRun({}, 1, runId);
    const send = createBaseEventSender(runId, store, tmpDir);

    for (let index = 0; index < 50; index += 1) {
      send({ type: 'notification', level: 'info', message: `event-${index}` });
    }
    await run.persistence?.flush();

    const events = await readTraceEvents(tmpDir, runId);
    expect(events.map((event: any) => event.message)).toEqual(
      Array.from({ length: 50 }, (_, index) => `event-${index}`),
    );
  });

  it('redacts credentials before trace events are persisted', async () => {
    const runId = 'run_trace_redact';
    const store = createAgentRunStore();
    const run = store.createRun({}, 1, runId);
    const send = createBaseEventSender(runId, store, tmpDir);

    send({ type: 'notification', level: 'warning', message: 'api_key=super-secret-value' });
    await run.persistence?.flush();

    const events = await readTraceEvents(tmpDir, runId);
    expect(events[0].message).toContain('[REDACTED]');
    expect(events[0].message).not.toContain('super-secret-value');
  });
});
