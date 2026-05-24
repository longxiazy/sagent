/**
 * Run Agent — 任务执行的共享工具函数
 *
 * 从 server.ts 和 routes/agent.ts 提取的公共逻辑：
 *   - 事件分发（store + reconnect 转发）
 *   - 记忆加载 + systemPrompt 构建
 *   - 运行后清理（checkpoint + run 关闭）
 */

import { loadMemory, buildMemoryPrompt } from '../agent/core/memory.ts';
import { removeCheckpoint, removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { shutdownChromeMcp } from '../agent/tools/chrome/mcp-client.ts';
import { appendTraceEvent } from './trace-store.ts';
import { log } from './logger.ts';

export function createBaseEventSender(runId: string, agentRunStore: any, memoryDir?: string) {
  return (payload: any) => {
    agentRunStore.addEvent(runId, payload);
    const traceWrite = appendTraceEvent(memoryDir, runId, payload).catch((err: any) => {
      log.warn(`[TraceStore] append failed runId=${runId}: ${err.message}`);
    });
    const run = agentRunStore.getRun(runId);
    if (run) {
      run.traceWrites = run.traceWrites || [];
      run.traceWrites.push(traceWrite);
    }
    if (run?._reconnectWriters) {
      for (const writer of run._reconnectWriters) {
        writer(payload);
      }
    }
  };
}

export async function loadMemoryForPrompt(memoryDir: string) {
  try {
    const memory = await loadMemory(memoryDir);
    const memoryPrompt = buildMemoryPrompt(memory);
    return { memory, systemPrompt: memoryPrompt || '' };
  } catch (err: any) {
    log.warn('Memory load failed:', err.message);
    return { memory: null, systemPrompt: '' };
  }
}

export async function cleanupAgentRun(checkpointDir: string | undefined, runId: string, agentRunStore: any, { removeSnapshots = false }: { removeSnapshots?: boolean } = {}) {
  if (checkpointDir) {
    // step-level checkpoint 只用于崩溃恢复，任务完成后可删除
    await removeCheckpoint(checkpointDir, runId).catch(() => {});
    // session snapshots 用于回滚，只在启动新任务时才清理
    if (removeSnapshots) {
      await removeSessionCheckpoints(checkpointDir, runId).catch(() => {});
    }
  }
  agentRunStore.closeRun(runId);
  // 只关闭本进程里的 Chrome MCP SSE client；外部 chrome:mcp bridge 和 Chrome 继续由独立进程管理。
  // 如果更看重复用连接，可在 .env 设 CHROME_MCP_KEEP_OPEN=true 跳过。
  if (process.env.CHROME_MCP_KEEP_OPEN !== 'true') {
    await shutdownChromeMcp().catch(err => {
      log.warn(`[cleanupAgentRun] shutdownChromeMcp 失败 runId=${runId} ${err?.message || err}`);
    });
  }
}
