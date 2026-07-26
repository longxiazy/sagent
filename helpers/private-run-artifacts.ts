import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { deleteTrace } from './trace-store.ts';

const SAFE_RUN_ID_RE = /^run_[a-z0-9]+_[a-z0-9]+$/i;

/**
 * 删除单个隐私 run 可能留下的、且能按 runId 定位的持久化产物。
 *
 * 只接受标准 runId，并且所有目标都是 dataDir 下的固定子路径，避免把清理范围
 * 扩大到项目目录中的其他数据。该函数用于启动前清掉复用 runId 的旧产物，
 * 以及正常结束或可捕获异常收尾时清理半成品；无法覆盖进程硬崩溃/断电场景。
 * 普通日志、LLM 日志和 chat-sessions 不在这里按 runId 删除，而是依靠写入前拦截。
 */
export async function removePrivateRunArtifacts(dataDir: string | undefined, runId: string): Promise<void> {
  if (!dataDir || !SAFE_RUN_ID_RE.test(runId)) return;

  await Promise.all([
    deleteTrace(dataDir, runId),
    removeSessionCheckpoints(dataDir, runId),
    rm(join(dataDir, 'worker-logs', `${runId}.log`), { force: true }).catch(() => {}),
    rm(join(dataDir, 'screenshots', runId), { recursive: true, force: true }).catch(() => {}),
  ]);
}
