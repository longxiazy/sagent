/**
 * Checkpoint — Agent 运行检查点持久化，支持服务重启后恢复未完成的任务
 *
 * 每次 Agent 执行一步后保存当前状态（history, step, task, model 等）到 JSON 文件。
 * 服务重启时扫描 checkpoints 目录，恢复所有未完成的运行。
 *
 * 存储位置：{CHECKPOINT_DIR}/checkpoints/{runId}.json
 * 使用原子写入（先写 .tmp 再 rename）防止写入中途崩溃导致文件损坏。
 *
 * 调用场景：
 *   - agent/desktop/agent.js 的 onCheckpoint 回调：每步执行后 saveCheckpoint
 *   - server.js 启动时：listCheckpoints 发现未完成任务 → resumeFromCheckpoint 恢复
 *   - routes/agent.js finally 块：任务完成后 removeCheckpoint 清理
 */

import { mkdir, writeFile, readFile, unlink, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../helpers/logger.js';

function checkpointPath(dir, runId) {
  return join(dir, 'checkpoints', `${runId}.json`);
}

function tmpPath(dir, runId) {
  return join(dir, 'checkpoints', `${runId}.json.tmp`);
}

export async function saveCheckpoint(dir, data) {
  const cpDir = join(dir, 'checkpoints');
  await mkdir(cpDir, { recursive: true });
  const tmp = tmpPath(dir, data.runId);
  const dest = checkpointPath(dir, data.runId);
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, dest);
}

export async function loadCheckpoint(dir, runId) {
  try {
    const raw = await readFile(checkpointPath(dir, runId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.warn(`Checkpoint load failed for ${runId}:`, err.message);
    return null;
  }
}

export async function listCheckpoints(dir) {
  const cpDir = join(dir, 'checkpoints');
  try {
    const files = await readdir(cpDir);
    const checkpoints = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(cpDir, f), 'utf8');
        checkpoints.push(JSON.parse(raw));
      } catch (err) {
        log.warn(`Checkpoint parse failed: ${f}:`, err.message);
      }
    }
    return checkpoints;
  } catch {
    return [];
  }
}

export async function removeCheckpoint(dir, runId) {
  try {
    await unlink(checkpointPath(dir, runId));
  } catch (err) {
    log.debug(`Checkpoint remove failed for ${runId}:`, err.message);
  }
}

export async function clearCheckpoints(dir) {
  const cpDir = join(dir, 'checkpoints');
  try {
    const files = await readdir(cpDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        await unlink(join(cpDir, f)).catch(() => {});
      }
    }
  } catch (err) {
    log.debug('Clear checkpoints failed:', err.message);
  }
}
