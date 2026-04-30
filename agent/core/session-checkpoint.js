/**
 * Session Checkpoint — 会话级健康检查点与中断恢复机制
 *
 * 与 agent/core/checkpoint.js（step 级原子写入，用于重启后继续任务）不同，
 * 本模块提供：
 *   1. 健康快照 — 每 N 步保存完整 history + state 到独立文件
 *   2. 回滚 API — 恢复到任意历史检查点
 *   3. 自动恢复 — decide 连续失败时自动回退到上一个健康快照
 *   4. 快照修剪 — 只保留最近 3 个健康快照 + 1 个失败快照
 *
 * 调用场景：
 *   - runtime.js: 每步成功后自动打健康快照
 *   - routes/agent.js: 提供 /api/agent/checkpoints 和 /api/agent/rollback 端点
 *   - desktop/agent.js: 异常检测后自动触发回滚
 */

import { mkdir, writeFile, readFile, unlink, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const HEALTH_CHECKPOINT_INTERVAL = 2;  // 每 2 步打一次健康快照
const KEEP_HEALTHY = 3;
const KEEP_FAILED = 1;

function sessionDir(dir, runId) {
  return join(dir, 'session-checkpoints', runId);
}

function healthyPath(dir, runId, step) {
  return join(sessionDir(dir, runId), `session-healthy-${step}.json`);
}

function failedPath(dir, runId, step) {
  return join(sessionDir(dir, runId), `session-failed-${step}.json`);
}

/**
 * 评估一次执行结果的健康度
 * 简单规则：result 不是错误信息且不为空，判断为健康
 */
function assessHealth(result) {
  if (!result || typeof result !== 'string') return 'unknown';
  if (result.startsWith('执行失败')) return 'unhealthy';
  if (result.startsWith('操作未获批准')) return 'degraded';
  return 'healthy';
}

/**
 * 对 state 做去敏处理，避免存储敏感信息
 */
function sanitizeState(state) {
  if (!state) return null;
  const safe = { ...state };
  // 移除不可序列化/敏感字段
  delete safe.chromium;
  delete safe.browserCandidatePaths;
  delete safe.onEvent;
  delete safe.browserSession;
  delete safe.observeDesktop;
  // 标记 browser session 存在，但不存储引用
  safe.browserSessionActive = Boolean(state.browserSession);
  return safe;
}

/**
 * 写入健康快照（只保留最近 KEEP_HEALTHY 个）
 */
export async function saveHealthySnapshot({ dir, runId, step, history, state, result, usage }) {
  const cpDir = sessionDir(dir, runId);
  await mkdir(cpDir, { recursive: true });

  const snapshot = {
    type: 'healthy',
    runId,
    step,
    history: history.map(h => ({
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
  const tmpFile = filePath + '.tmp';
  await writeFile(tmpFile, JSON.stringify(snapshot), 'utf8');
  await rename(tmpFile, filePath);

  // 修剪旧快照
  await pruneSnapshots(dir, runId, 'healthy', KEEP_HEALTHY);
}

/**
 * 写入失败快照（只保留最近 KEEP_FAILED 个）
 */
export async function saveFailedSnapshot({ dir, runId, step, history, error, state }) {
  const cpDir = sessionDir(dir, runId);
  await mkdir(cpDir, { recursive: true });

  const snapshot = {
    type: 'failed',
    runId,
    step,
    error: error?.message || String(error || ''),
    history: (history || []).slice(-5).map(h => ({
      step: h.step,
      action: h.action,
      result: typeof h.result === 'string' ? h.result.slice(0, 500) : '',
    })),
    state: sanitizeState(state),
    timestamp: Date.now(),
  };

  const filePath = failedPath(dir, runId, step);
  const tmpFile = filePath + '.tmp';
  await writeFile(tmpFile, JSON.stringify(snapshot), 'utf8');
  await rename(tmpFile, filePath);

  await pruneSnapshots(dir, runId, 'failed', KEEP_FAILED);
}

/**
 * 加载最新的健康快照（step 小于等于 targetStep）
 */
export async function loadLatestHealthySnapshot(dir, runId, upToStep) {
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
      .sort((a, b) => b.step - a.step); // 最新的在前

    if (healthyFiles.length === 0) return null;

    const raw = await readFile(join(cpDir, healthyFiles[0].file), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 列出所有检查点
 */
export async function listSessionCheckpoints(dir, runId) {
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

/**
 * 清理指定 runId 的所有会话检查点
 */
export async function clearSessionCheckpoints(dir, runId) {
  const cpDir = sessionDir(dir, runId);
  try {
    await rm(cpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * 修剪太旧的快照
 */
async function pruneSnapshots(dir, runId, type, keepCount) {
  const cpDir = sessionDir(dir, runId);
  try {
    const files = await readdir(cpDir);
    // 清理残留的 .tmp 文件
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
      .sort((a, b) => b.step - a.step); // 最新的在前

    for (let i = keepCount; i < snapshots.length; i++) {
      await unlink(join(cpDir, snapshots[i].file)).catch(() => {});
    }
  } catch { /* ignore */ }
}

export { HEALTH_CHECKPOINT_INTERVAL, KEEP_HEALTHY, KEEP_FAILED };
