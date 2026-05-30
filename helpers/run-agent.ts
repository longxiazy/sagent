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
import { shutdownChromeMcp, closeAllChromePagesQuiet } from '../agent/tools/chrome/mcp-client.ts';
import { resetChromeSnapshotState } from '../agent/tools/chrome/execute.ts';
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
  // 先把本 run 标记为结束（从 active 计数里移除），再判断是否还有其它 run 在跑。
  // 顺序很关键：若先 count 再 closeRun，本 run 自己仍算 active，浏览器永不释放。
  agentRunStore.closeRun(runId);

  // 浏览器是进程级共享资源（单例 MCP + 模块级 snapshot）。并发模式下，
  // 只有当没有任何其它 run 还在跑时，才真正关闭浏览器 / 重置 snapshot / 断 MCP——
  // 否则会清掉别的 run 正在使用的浏览器状态。
  const otherRunsActive = agentRunStore.countActiveRuns() > 0;
  if (otherRunsActive) {
    log.debug(`[cleanupAgentRun] 仍有 ${agentRunStore.countActiveRuns()} 个 run 在跑，跳过浏览器清理 runId=${runId}`);
    return;
  }

  resetChromeSnapshotState();
  // run 结束（或异常）默认关闭本次 run 期间打开的 Chrome tab，避免长期跑下来 tab 堆积；
  // 设 CHROME_MCP_KEEP_TABS=true 跳过（适合调试或想保留页面看结果的场景）。
  // chrome-devtools-mcp 不允许关最后一个 page，会自动留一个 tab 兜底。
  // 必须在 shutdownChromeMcp 之前调用，否则 SSE client 已断就无法 close_page。
  if (process.env.CHROME_MCP_KEEP_TABS !== 'true') {
    await closeAllChromePagesQuiet().catch(err => {
      log.warn(`[cleanupAgentRun] closeAllChromePages 失败 runId=${runId} ${err?.message || err}`);
    });
  }
  // 只关闭本进程里的 Chrome MCP SSE client；外部 chrome:mcp bridge 和 Chrome 继续由独立进程管理。
  // 如果更看重复用连接，可在 .env 设 CHROME_MCP_KEEP_OPEN=true 跳过。
  if (process.env.CHROME_MCP_KEEP_OPEN !== 'true') {
    await shutdownChromeMcp().catch(err => {
      log.warn(`[cleanupAgentRun] shutdownChromeMcp 失败 runId=${runId} ${err?.message || err}`);
    });
  }
}
