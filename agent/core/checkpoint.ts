/**
 * Checkpoint — Session 级健康快照：运行中回滚到任意历史步骤
 *
 * 存储位置：
 *   Session 级：{dir}/session-checkpoints/{runId}/session-healthy-{step}.json
 *
 * 隐私 run 在已建立的异步上下文中跳过 Session 快照写入。普通 run 的写入优先
 * 采用“先写 .tmp 再 rename”的原子替换；底层替换失败时才回退为直接写目标文件，
 * 因此不能把所有路径都描述成严格原子写入。
 *
 * 历史注记：曾有一套 Step 级检查点(每步覆盖写 {dir}/checkpoints/{runId}.json)
 * 用于服务重启后自动恢复未完成任务，现已移除；重启不再续跑历史 run。
 */

import { mkdir, writeFile, readFile, unlink, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isPrivateRun } from '../../helpers/private-run.ts';
import type { ActionResultStatus, AgentRuntimeState, AgentStep, JsonObject, TokenUsage } from './contracts.ts';

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

// ─── 常量 ────────────────────────────────────────────────

/** 健康快照写入间隔（每 N 步写一次，当前恒为 1，即每步都写） */
const HEALTH_CHECKPOINT_INTERVAL = 1;
/** 健康快照最多保留份数，超出删除最旧的 */
const KEEP_HEALTHY = 30;

// ─── Session 级快照（回滚）─────────────────────────────────

function sessionDir(dir: string, runId: string) {
  return join(dir, 'session-checkpoints', runId);
}

/**
 * 列出已有 Session 快照的运行 ID。
 * 当前使用：agent-run-start.ts 启动清理时枚举并删除旧快照。
 */
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

async function pruneSnapshots(dir: string, runId: string, keepCount: number) {
  const cpDir = sessionDir(dir, runId);
  try {
    const files = await readdir(cpDir);
    for (const f of files) {
      if (f.endsWith('.tmp')) {
        await unlink(join(cpDir, f)).catch(() => {});
      }
    }
    const snapshots = files
      .filter(f => f.startsWith('session-healthy-') && f.endsWith('.json'))
      .map(f => {
        const match = f.match(/session-healthy-(\d+)\.json$/);
        return { file: f, step: match ? parseInt(match[1], 10) : 0 };
      })
      .sort((a, b) => b.step - a.step);

    for (let i = keepCount; i < snapshots.length; i++) {
      await unlink(join(cpDir, snapshots[i].file)).catch(() => {});
    }
  } catch { /* ignore */ }
}

/**
 * 保存某一步的健康快照（history/state/用量/健康度），原子写入后裁剪超量快照。
 * 用法：每步结束后调用；隐私 run 跳过落盘。
 * 当前使用：runtime.ts 步骤循环（经 persistence 队列）、worker runner.ts 的桥接写入。
 */
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

  await pruneSnapshots(dir, runId, KEEP_HEALTHY);
}

/**
 * 读取某运行 step ≤ upToStep 的最新健康快照，用于回滚。
 * 当前使用：runtime.ts 回滚时取目标步骤的前一步、
 * agent-run-request.ts / agent-run-execution.ts 的会话恢复。
 */
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

/**
 * 列出某运行的全部快照元信息（step/type/health/时间），供前端回滚面板展示。
 * 当前使用：routes/agent-checkpoints.ts。
 */
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

export { HEALTH_CHECKPOINT_INTERVAL, KEEP_HEALTHY };

// ─── Session 快照清理（启动前、取消或运行结束时调用）──────────────

/**
 * 删除某运行的全部 Session 快照（取消、完成、启动清理时调用）。
 * 当前使用：helpers/run-agent.ts、helpers/private-run-artifacts.ts、routes/agent-run-control.ts、routes/agent-run-start.ts。
 */
export async function removeSessionCheckpoints(dir: string, runId: string) {
  const cpDir = sessionDir(dir, runId);
  await rm(cpDir, { recursive: true, force: true });
}
