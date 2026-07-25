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
 * 隐私 run 在已建立的异步上下文中跳过 Step checkpoint 和 Session 快照写入。
 * 普通 run 的写入优先采用“先写 .tmp 再 rename”的原子替换；底层替换失败时
 * 才回退为直接写目标文件，因此不能把所有路径都描述成严格原子写入。
 */

import { mkdir, writeFile, readFile, unlink, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../helpers/logger.ts';
import { isPrivateRun } from '../../helpers/private-run.ts';
import type { ActionResultStatus, AgentRuntimeState, AgentStep, JsonObject, TokenUsage } from './contracts.ts';

export type StepCheckpoint = { runId: string; [key: string]: unknown };

export interface SessionSnapshot {
  type: 'healthy';
  runId: string;
  step: number;
  history: AgentStep[];
  state: JsonObject | null;
  usage: Partial<TokenUsage> | JsonObject;
  health: 'healthy' | 'unhealthy' | 'degraded' | 'unknown';
  resultStatus?: ActionResultStatus;
  resultError?: string | null;
  timestamp: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStepCheckpoint(value: unknown): value is StepCheckpoint {
  return Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).runId === 'string');
}

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

export async function saveCheckpoint(dir: string, data: StepCheckpoint): Promise<void> {
  // 先在这里拦截，避免隐私任务连 checkpoints 目录都创建出来。
  if (isPrivateRun()) return;
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

export async function listCheckpoints(dir: string): Promise<StepCheckpoint[]> {
  const cpDir = join(dir, 'checkpoints');
  try {
    const files = await readdir(cpDir);
    const checkpoints: StepCheckpoint[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(cpDir, f), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isStepCheckpoint(parsed)) checkpoints.push(parsed);
        else log.warn(`Checkpoint validation failed: ${f}`);
      } catch (err: unknown) {
        log.warn(`Checkpoint parse failed: ${f}:`, errorMessage(err));
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
  } catch (err: unknown) {
    log.debug(`Checkpoint remove failed for ${runId}:`, errorMessage(err));
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
  } catch (err: unknown) {
    log.debug('Clear checkpoints failed:', errorMessage(err));
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

function assessHealth(result: unknown, resultStatus?: ActionResultStatus): SessionSnapshot['health'] {
  if (resultStatus === 'failed') return 'unhealthy';
  if (resultStatus === 'rejected') return 'degraded';
  if (!result || typeof result !== 'string') return 'unknown';
  // Legacy snapshots from before resultStatus existed.
  if (result.startsWith('执行失败')) return 'unhealthy';
  if (result.startsWith('操作未获批准')) return 'degraded';
  return 'healthy';
}

function sanitizeState(state: AgentRuntimeState | null | undefined): JsonObject | null {
  if (!state) return null;
  const safe: Record<string, unknown> = { ...state };
  delete safe.chromium;
  delete safe.browserCandidatePaths;
  delete safe.onEvent;
  delete safe.browserSession;
  delete safe.observeDesktop;
  safe.browserSessionActive = Boolean(state.browserSession) || Boolean(state.browserSessionActive);
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

export async function saveHealthySnapshot({
  dir,
  runId,
  step,
  history,
  state,
  result,
  resultStatus,
  resultError,
  usage = {},
}: {
  dir: string;
  runId: string;
  step: number;
  history: AgentStep[];
  state: AgentRuntimeState | null;
  result: unknown;
  resultStatus?: ActionResultStatus;
  resultError?: string | null;
  usage?: Partial<TokenUsage> | JsonObject;
}): Promise<void> {
  // 与 Step checkpoint 共用同一条隐私防线；回滚所需的快照也不能落盘。
  if (isPrivateRun()) return;
  const cpDir = sessionDir(dir, runId);
  await mkdir(cpDir, { recursive: true });

  const snapshot: SessionSnapshot = {
    type: 'healthy',
    runId,
    step,
    history: history.map(h => ({
      step: h.step,
      rationale: h.rationale,
      action: h.action,
      result: typeof h.result === 'string' ? h.result.slice(0, 2000) : '',
      resultStatus: h.resultStatus,
      resultError: h.resultError,
      url: h.url,
      title: h.title,
      observation: h.observation ? { url: h.observation.url, title: h.observation.title, text: typeof h.observation.text === 'string' ? h.observation.text.slice(0, 500) : undefined } : undefined,
    })),
    state: sanitizeState(state),
    usage: usage || {},
    health: assessHealth(result, resultStatus),
    resultStatus,
    resultError,
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

export async function loadLatestHealthySnapshot(dir: string, runId: string, upToStep: number): Promise<SessionSnapshot | null> {
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
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const snapshot = parsed as Partial<SessionSnapshot>;
    if (snapshot.type !== 'healthy' || snapshot.runId !== runId || !Number.isInteger(snapshot.step) || !Array.isArray(snapshot.history)) return null;
    return snapshot as SessionSnapshot;
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

// ─── Session 快照清理（启动前、取消或运行结束时调用）──────────────

export async function removeSessionCheckpoints(dir: string, runId: string) {
  const cpDir = sessionDir(dir, runId);
  await rm(cpDir, { recursive: true, force: true });
}
