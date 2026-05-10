import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './logger.ts';

function tracesDir(memoryDir: string) {
  return join(memoryDir, 'traces');
}

function tracePath(memoryDir: string, runId: string) {
  return join(tracesDir(memoryDir), `${runId}.jsonl`);
}

function validRunId(runId: string) {
  return /^run_[a-z0-9]+_[a-z0-9]+$/i.test(runId);
}

export async function appendTraceEvent(memoryDir: string | undefined, runId: string, event: any) {
  if (!memoryDir || !validRunId(runId)) return;

  const dir = tracesDir(memoryDir);
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({ ...event, runId: event?.runId || runId })}\n`;
  await writeFile(tracePath(memoryDir, runId), line, { encoding: 'utf8', flag: 'a' });
}

export async function readTraceEvents(memoryDir: string | undefined, runId: string) {
  if (!memoryDir || !validRunId(runId)) return [];

  try {
    const raw = await readFile(tracePath(memoryDir, runId), 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (err: any) {
        log.warn(`[TraceStore] skip malformed trace line runId=${runId}: ${err.message}`);
      }
    }
    return events;
  } catch {
    return [];
  }
}

export async function listTraceRuns(memoryDir: string | undefined) {
  if (!memoryDir) return [];

  try {
    const files = await readdir(tracesDir(memoryDir));
    return files
      .filter(file => file.endsWith('.jsonl'))
      .map(file => file.slice(0, -'.jsonl'.length))
      .filter(validRunId);
  } catch {
    return [];
  }
}

export async function deleteTrace(memoryDir: string | undefined, runId: string) {
  if (!memoryDir || !validRunId(runId)) return;

  try {
    await unlink(tracePath(memoryDir, runId));
  } catch {
    // ignore missing trace files
  }
}
