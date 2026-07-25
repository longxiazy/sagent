/**
 * Run Agent — 任务执行的共享工具函数
 *
 * 从 server.ts 和 routes/agent-run-*.ts 提取的公共逻辑：
 *   - 事件分发（store + reconnect 转发）
 *   - 记忆加载 + systemPrompt 构建
 *   - 运行收尾（持久化 flush、checkpoint/隐私产物清理、Chrome MCP 状态清理、run 关闭）
 */

import { loadMemory, buildMemoryPrompt } from '../agent/core/memory.ts';
import { removeCheckpoint, removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { shutdownChromeMcp, closeAllChromePagesQuiet, loadChromeMcpConfig } from '../agent/tools/chrome/mcp-client.ts';
import { resetChromeSnapshotState } from '../agent/tools/chrome/execute.ts';
import { appendTraceEvent } from './trace-store.ts';
import { log } from './logger.ts';
import { isPrivateRun, withPrivateRun } from './private-run.ts';
import { removePrivateRunArtifacts } from './private-run-artifacts.ts';
import type { AgentEvent, AgentRunStore, TerminalRunStatus } from '../agent/core/contracts.ts';
import { redactSensitiveData } from './redact.ts';

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

export function createBaseEventSender(
  runId: string,
  agentRunStore: AgentRunStore,
  memoryDir?: string,
  { persistTrace = true }: { persistTrace?: boolean } = {},
) {
  const stageTimes = new Map<string, number>();
  const modelTimes = new Map<string, number>();

  return (payload: AgentEvent): AgentEvent => {
    const timestamp = Number.isFinite(payload?.timestamp) ? payload.timestamp : Date.now();
    const attemptPrefix = Number.isInteger(payload?.attempt) && Number(payload.attempt) > 0
      ? `attempt_${payload.attempt}_`
      : '';
    const spanId = `${attemptPrefix}${buildSpanId(payload)}`;
    const rawParentId = buildParentId(payload);
    const parentId = rawParentId ? `${attemptPrefix}${rawParentId}` : null;
    const event = redactSensitiveData({
      ...payload,
      runId: payload?.runId || runId,
      timestamp,
      trace_id: payload?.trace_id || runId,
      span_id: spanId,
      operation: buildOperation(payload),
      ...(parentId ? { parent_id: parentId } : {}),
    }) as AgentEvent;

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

    const sequencedEvent = agentRunStore.addEvent(runId, event);
    const run = agentRunStore.getRun(runId);
    // 事件先进入内存 run store 并发送给 SSE；隐私任务只跳过 JSONL trace 的持久化。
    if (persistTrace && !isPrivateRun()) {
      const writeTrace = () => appendTraceEvent(memoryDir, runId, sequencedEvent);
      const traceWrite = run?.persistence ? run.persistence.enqueue(writeTrace) : writeTrace();
      traceWrite.catch((err: any) => {
        log.warn(`[TraceStore] append failed runId=${runId}: ${err.message}`);
      });
    }
    if (run?._reconnectWriters) {
      for (const writer of run._reconnectWriters) {
        writer(sequencedEvent);
      }
    }
    return sequencedEvent;
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

export async function cleanupAgentRun(
  checkpointDir: string | null | undefined,
  runId: string,
  agentRunStore: AgentRunStore,
  { removeSnapshots = false, finalStatus }: { removeSnapshots?: boolean; finalStatus?: TerminalRunStatus } = {},
) {
  // start 路由、取消路径和 checkpoint resume 都会调用这里；先 flush 串行写队列，
  // 再清理文件并关闭 run，保证最后一个事件/快照不会在清理之后落盘。
  const run = agentRunStore.getRun(runId);
  const privateMode = run?.meta?.privateMode === true;
  await run?.persistence?.flush();
  if (privateMode) {
    const dataDir = typeof run?.meta?.dataDir === 'string' ? run.meta.dataDir : checkpointDir;
    await withPrivateRun(true, () => removePrivateRunArtifacts(dataDir, runId));
  }
  if (checkpointDir && !privateMode) {
    // step-level checkpoint 只用于崩溃恢复，任务完成后可删除
    await removeCheckpoint(checkpointDir, runId).catch(() => {});
    // Session 快照用于回滚，默认保留；只有调用方明确要求批量收尾时才删除。
    if (removeSnapshots) {
      await removeSessionCheckpoints(checkpointDir, runId).catch(() => {});
    }
  }
  agentRunStore.closeRun(runId, finalStatus);
  resetChromeSnapshotState();
  // run 结束（或异常）默认关闭本次 run 期间打开的 Chrome tab，避免长期跑下来 tab 堆积；
  // 设 CHROME_MCP_KEEP_TABS=true 跳过（适合调试或想保留页面看结果的场景）。
  // chrome-devtools-mcp 不允许关最后一个 page，会自动留一个 tab 兜底。
  // 必须在 shutdownChromeMcp 之前调用，否则 SSE client 已断就无法 close_page。
  const chromeConfig = loadChromeMcpConfig();
  if (!chromeConfig.keepTabs) {
    await closeAllChromePagesQuiet().catch(err => {
      if (!privateMode) {
        log.warn(`[cleanupAgentRun] closeAllChromePages 失败 runId=${runId} ${err?.message || err}`);
      }
    });
  }
  // 只关闭本进程里的 Chrome MCP SSE client；外部 chrome:mcp bridge 和 Chrome 继续由独立进程管理。
  // 如果更看重复用连接，可在 .env 设 CHROME_MCP_KEEP_OPEN=true 跳过。
  if (!chromeConfig.keepOpen) {
    await shutdownChromeMcp().catch(err => {
      if (!privateMode) {
        log.warn(`[cleanupAgentRun] shutdownChromeMcp 失败 runId=${runId} ${err?.message || err}`);
      }
    });
  }
}
