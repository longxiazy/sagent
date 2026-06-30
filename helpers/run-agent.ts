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

function spanPart(value: any) {
  return String(value ?? '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function buildSpanId(payload: any) {
  if (payload?.span_id) return payload.span_id;

  if (payload?.type === 'step') {
    return `step_${spanPart(payload.step)}_${spanPart(payload.stage)}`;
  }
  if (payload?.type === 'model_plan') {
    return `step_${spanPart(payload.step)}_plan_${spanPart(payload.stage)}_${spanPart(payload.model || 'group')}`;
  }
  if (payload?.type === 'terminal_output') {
    return `step_${spanPart(payload.step)}_terminal_${spanPart(payload.phase)}_${spanPart(payload.sequence ?? '')}`;
  }
  if (payload?.type === 'session_checkpoint') {
    return `step_${spanPart(payload.step)}_checkpoint`;
  }
  return spanPart(payload?.type || 'event');
}

function buildParentId(payload: any) {
  if (payload?.parent_id) return payload.parent_id;
  if (payload?.step == null) return null;
  if (payload?.type === 'terminal_output') return `step_${spanPart(payload.step)}_execute`;
  if (payload?.type === 'model_plan') return `step_${spanPart(payload.step)}_observe`;
  if (payload?.type === 'step' && payload.stage === 'action') return `step_${spanPart(payload.step)}_observe`;
  if (payload?.type === 'step' && payload.stage === 'result') return `step_${spanPart(payload.step)}_action`;
  if (payload?.type === 'step') return `step_${spanPart(payload.step)}`;
  return null;
}

function buildOperation(payload: any) {
  if (payload?.operation) return payload.operation;
  if (payload?.type === 'step') {
    if (payload.stage === 'result') return 'execute';
    return payload.stage || 'step';
  }
  if (payload?.type === 'model_plan') return 'decide';
  if (payload?.type === 'terminal_output') return 'terminal';
  return payload?.type || 'event';
}

export function createBaseEventSender(runId: string, agentRunStore: any, memoryDir?: string) {
  const stageTimes = new Map<string, number>();
  const modelTimes = new Map<string, number>();

  return (payload: any) => {
    const timestamp = Number.isFinite(payload?.timestamp) ? payload.timestamp : Date.now();
    const spanId = buildSpanId(payload);
    const parentId = buildParentId(payload);
    const event: any = {
      ...payload,
      runId: payload?.runId || runId,
      timestamp,
      trace_id: payload?.trace_id || runId,
      span_id: spanId,
      operation: buildOperation(payload),
      ...(parentId ? { parent_id: parentId } : {}),
    };

    if (event.usage) {
      event.input_tokens = event.input_tokens ?? event.usage.prompt_tokens ?? null;
      event.output_tokens = event.output_tokens ?? event.usage.completion_tokens ?? event.usage.output_tokens ?? null;
    }

    if (event.type === 'step' && event.step != null) {
      const prevStage = event.stage === 'action' ? 'observe' : event.stage === 'result' ? 'action' : null;
      const prev = prevStage ? stageTimes.get(`${event.step}:${prevStage}`) : null;
      if (prev != null && timestamp >= prev) {
        event.start_time = event.start_time || prev;
        event.end_time = event.end_time || timestamp;
        event.duration_ms = event.duration_ms ?? (timestamp - prev);
      }
      stageTimes.set(`${event.step}:${event.stage}`, timestamp);
    }

    if (event.type === 'model_plan' && event.step != null) {
      const modelKey = `${event.step}:${event.model || 'group'}`;
      if (event.stage === 'start') {
        stageTimes.set(`${event.step}:plan`, timestamp);
      }
      if (event.stage === 'thinking') {
        modelTimes.set(modelKey, timestamp);
      }
      if (['success', 'winner', 'failed', 'cancelled'].includes(event.stage)) {
        const started = modelTimes.get(modelKey) ?? stageTimes.get(`${event.step}:plan`);
        if (started != null && timestamp >= started) {
          event.start_time = event.start_time || started;
          event.end_time = event.end_time || timestamp;
          event.duration_ms = event.duration_ms ?? (timestamp - started);
        }
      }
    }

    agentRunStore.addEvent(runId, event);
    const traceWrite = appendTraceEvent(memoryDir, runId, event).catch((err: any) => {
      log.warn(`[TraceStore] append failed runId=${runId}: ${err.message}`);
    });
    const run = agentRunStore.getRun(runId);
    if (run) {
      run.traceWrites = run.traceWrites || [];
      run.traceWrites.push(traceWrite);
    }
    if (run?._reconnectWriters) {
      for (const writer of run._reconnectWriters) {
        writer(event);
      }
    }
    return event;
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
