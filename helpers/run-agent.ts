/**
 * Run Agent — 任务执行的共享工具函数
 *
 * 从 server.ts 和 routes/agent.ts 提取的公共逻辑：
 *   - 事件分发（store + reconnect 转发）
 *   - 记忆加载 + systemPrompt 构建
 *   - 运行后清理（checkpoint + run 关闭）
 */

import { loadMemory, buildMemoryPrompt } from '../agent/core/memory.ts';
import { removeCheckpoint } from '../agent/core/checkpoint.ts';
import { log } from './logger.ts';

export function createBaseEventSender(runId: string, agentRunStore: any) {
  return (payload: any) => {
    agentRunStore.addEvent(runId, payload);
    const run = agentRunStore.getRun(runId);
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

export function cleanupAgentRun(checkpointDir: string | undefined, runId: string, agentRunStore: any) {
  if (checkpointDir) {
    removeCheckpoint(checkpointDir, runId).catch(() => {});
  }
  agentRunStore.closeRun(runId);
}
