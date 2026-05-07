/**
 * Checkpoint — Agent 状态持久化：重启恢复 + 会话回滚
 *
 * 两套机制共用一个模块：
 *   1. Step 级检查点 — 每步覆盖写入，用于服务重启后恢复未完成任务
 *   2. Session 级快照 — 每步独立文件，用于运行中回滚到任意历史步骤
 *
 * 存储位置：
 *   Step 级：{dir}/checkpoints/{runId}.json          （单文件，覆盖写入）
 *   Session 级：{dir}/session-checkpoints/{runId}/session-healthy-{step}.json
 *
 * 所有写入使用原子操作（先写 .tmp 再 rename）防崩溃损坏。
 */

import { mkdir, writeFile, readFile, unlink, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../helpers/logger.ts';

// ─── 常量 ────────────────────────────────────────────────

const HEALTH_CHECKPOINT_INTERVAL = 1;
const KEEP_HEALTHY = 30;
const KEEP_FAILED = 3;

// ─── Step 级检查点（重启恢复）────────────────────────────

function checkpointPath(dir: string, runId: string) {
  return join(dir, 'checkpoints', `${runId}.json`);
}

function tmpPath(dir: string, runId: string) {
  return join(dir, 'checkpoints', `${runId}.json.tmp`);
}

export async function saveCheckpoint(dir: string, data: any) {
  const cpDir = join(dir, 'checkpoints');
  await mkdir(cpDir, { recursive: true });
  const tmp = tmpPath(dir, data.runId);
  const dest = checkpointPath(dir, data.runId);
  const json = JSON.stringify(data);
  try {
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, dest);
  } catch {
    await writeFile(dest, json, 'utf8');
  }
}

export async function listCheckpoints(dir: string) {
  const cpDir = join(dir, 'checkpoints');
  try {
    const files = await readdir(cpDir);
    const checkpoints = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(cpDir, f), 'utf8');
        checkpoints.push(JSON.parse(raw));
      } catch (err: any) {
        log.warn(`Checkpoint parse failed: ${f}:`, err.message);
      }
    }
    return checkpoints;
  } catch {
    return [];
  }
}

export async function removeCheckpoint(dir: string, runId: string) {
  try {
    await unlink(checkpointPath(dir, runId));
  } catch (err: any) {
    log.debug(`Checkpoint remove failed for ${runId}:`, err.message);
  }
}

export async function clearCheckpoints(dir: string) {
  const cpDir = join(dir, 'checkpoints');
  try {
    const files = await readdir(cpDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        await unlink(join(cpDir, f)).catch(() => {});
      }
    }
  } catch (err: any) {
    log.debug('Clear checkpoints failed:', err.message);
  }
}

// ─── Session 级快照（回滚）─────────────────────────────────

function sessionDir(dir: string, runId: string) {
  return join(dir, 'session-checkpoints', runId);
}

export async function listSessionCheckpointRuns(dir: string) {
  const scDir = join(dir, 'session-checkpoints');
  try {
    const entries = await readdir(scDir);
    return entries.filter(e => !e.startsWith('.'));
  } catch {
    return [];
  }
}

function healthyPath(dir: string, runId: string, step: number) {
  return join(sessionDir(dir, runId), `session-healthy-${step}.json`);
}

function failedPath(dir: string, runId: string, step: number) {
  return join(sessionDir(dir, runId), `session-failed-${step}.json`);
}

function assessHealth(result: any) {
  if (!result || typeof result !== 'string') return 'unknown';
  if (result.startsWith('执行失败')) return 'unhealthy';
  if (result.startsWith('操作未获批准')) return 'degraded';
  return 'healthy';
}

function sanitizeState(state: any) {
  if (!state) return null;
  const safe = { ...state };
  delete safe.chromium;
  delete safe.browserCandidatePaths;
  delete safe.onEvent;
  delete safe.browserSession;
  delete safe.observeDesktop;
  safe.browserSessionActive = Boolean(state.browserSession);
  return safe;
}

async function pruneSnapshots(dir: string, runId: string, type: string, keepCount: number) {
  const cpDir = sessionDir(dir, runId);
  try {
    const files = await readdir(cpDir);
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        await unlink(join(cpDir, f)).catch(() => {});
      }
    }
    const snapshots = files
      .filter(f => f.startsWith(`session-${type}-`) && f.endsWith('.json'))
      .map(f => {
        const match = f.match(new RegExp(`session-${type}-(\\d+)\\.json$`));
        return { file: f, step: match ? parseInt(match[1], 10) : 0 };
      })
      .sort((a, b) => b.step - a.step);

    for (let i = keepCount; i < snapshots.length; i++) {
      await unlink(join(cpDir, snapshots[i].file)).catch(() => {});
    }
  } catch { /* ignore */ }
}

export async function saveHealthySnapshot({ dir, runId, step, history, state, result, usage = {} }: { dir: any; runId: any; step: any; history: any; state: any; result: any; usage?: any }) {
  const cpDir = sessionDir(dir, runId);
  await mkdir(cpDir, { recursive: true });

  const snapshot = {
    type: 'healthy',
    runId,
    step,
    history: history.map((h: any) => ({
      step: h.step,
      rationale: h.rationale,
      action: h.action,
      result: typeof h.result === 'string' ? h.result.slice(0, 2000) : '',
      url: h.url,
      title: h.title,
      observation: h.observation ? { url: h.observation.url, title: h.observation.title, text: typeof h.observation.text === 'string' ? h.observation.text.slice(0, 500) : undefined } : undefined,
    })),
    state: sanitizeState(state),
    usage: usage || {},
    health: assessHealth(result),
    timestamp: Date.now(),
  };

  const filePath = healthyPath(dir, runId, step);
  const data = JSON.stringify(snapshot);
  try {
    const tmpFile = filePath + '.tmp';
    await writeFile(tmpFile, data, 'utf8');
    await rename(tmpFile, filePath);
  } catch {
    await mkdir(cpDir, { recursive: true });
    await writeFile(filePath, data, 'utf8');
  }

  await pruneSnapshots(dir, runId, 'healthy', KEEP_HEALTHY);
}

export async function loadLatestHealthySnapshot(dir: string, runId: string, upToStep: number) {
  const cpDir = sessionDir(dir, runId);
  try {
    const files = await readdir(cpDir);
    const healthyFiles = files
      .filter(f => f.startsWith('session-healthy-') && f.endsWith('.json'))
      .map(f => {
        const match = f.match(/session-healthy-(\d+)\.json$/);
        return { file: f, step: match ? parseInt(match[1], 10) : 0 };
      })
      .filter(f => f.step <= upToStep)
      .sort((a, b) => b.step - a.step);

    if (healthyFiles.length === 0) return null;

    const raw = await readFile(join(cpDir, healthyFiles[0].file), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listSessionCheckpoints(dir: string, runId: string) {
  const cpDir = sessionDir(dir, runId);
  try {
    const files = await readdir(cpDir);
    const result = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(cpDir, f), 'utf8');
        const parsed = JSON.parse(raw);
        result.push({
          step: parsed.step,
          type: parsed.type,
          health: parsed.health,
          timestamp: parsed.timestamp,
          error: parsed.error || null,
          file: f,
        });
      } catch { /* skip corrupt files */ }
    }
    return result.sort((a, b) => a.step - b.step);
  } catch {
    return [];
  }
}

// ─── 导出常量 ────────────────────────────────────────────

export { HEALTH_CHECKPOINT_INTERVAL, KEEP_HEALTHY, KEEP_FAILED };

// ─── Session 快照清理（运行结束后调用）────────────────────────

export async function removeSessionCheckpoints(dir: string, runId: string) {
  const cpDir = sessionDir(dir, runId);
  await rm(cpDir, { recursive: true, force: true });
}
