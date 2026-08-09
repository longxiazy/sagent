/**
 * Run Agent — 任务执行的共享工具函数
 *
 * 从 server.ts 和 routes/agent-run-*.ts 提取的公共逻辑：
 *   - 事件分发（store + reconnect 转发 + OTel span 组装）
 *   - 记忆加载 + systemPrompt 构建
 *   - 运行收尾（持久化 flush、checkpoint/隐私产物清理、Chrome MCP 状态清理、run 关闭）
 */

import { loadMemory, buildMemoryPrompt } from '../agent/core/memory.ts';
import { removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { shutdownChromeMcp, closeAllChromePagesQuiet, loadChromeMcpConfig } from '../agent/tools/chrome/mcp-client.ts';
import { resetChromeSnapshotState } from '../agent/tools/chrome/execute.ts';
import { appendTraceEvent } from './trace-store.ts';
import { createSpanAssembler } from './telemetry/span-assembler.ts';
import { log } from './logger.ts';
import { isPrivateRun, withPrivateRun } from './private-run.ts';
import { removePrivateRunArtifacts } from './private-run-artifacts.ts';
import type { AgentEvent, AgentRunStore, TerminalRunStatus } from '../agent/core/contracts.ts';
import { redactSensitiveData } from './redact.ts';

/**
 * 事件流的统一出口：盖上 OTel 追踪字段、脱敏、进 run store、落 JSONL trace。
 *
 * 这是全系统唯一的事件汇聚点——sandboxed worker 的事件经 agent/worker/runner.ts
 * 桥接回主进程后也走这里，所以在此组装 span 就同时覆盖两种 runner，
 * runtime.ts 的步骤循环无需改动，也不必跨进程传播 OTel context。
 *
 * trace_id / span_id / parent_id 由 span-assembler 派生，是 W3C 合规的 hex，
 * 可被 Jaeger / Zipkin 等标准工具消费（转换见 scripts/trace-to-otlp.ts）。
 */
export function createBaseEventSender(
  runId: string,
  agentRunStore: AgentRunStore,
  memoryDir?: string,
  {
    persistTrace = true,
    sessionId = null,
    attempt = 1,
    projectId = null,
  }: {
    persistTrace?: boolean;
    sessionId?: string | null;
    attempt?: number;
    projectId?: string | null;
  } = {},
) {
  // 组装器同时负责 span 树与阶段时长；原先分散的 stageTimes/modelTimes 已并入其中。
  // 这里只取它算出的 trace/span ID 回填进事件，不导出 span，因此不开内容捕获——
  // 内容本来就完整存在 JSONL 事件里，再往 span 属性复制一份纯属浪费内存。
  // 需要内容时由 scripts/trace-to-otlp.ts --content 在导出时按需生成。
  const assembler = createSpanAssembler({ sessionId, runId, attempt, projectId });
  // 阶段起点：事件流只在阶段结束时给时间点，duration_ms 沿用「距上一相关事件」的口径。
  const stageTimes = new Map<string, number>();
  const modelTimes = new Map<string, number>();

  return (payload: AgentEvent): AgentEvent => {
    const timestamp = Number.isFinite(payload?.timestamp) ? payload.timestamp : Date.now();
    // 先脱敏再组装，保证 span 属性继承的是已脱敏内容。
    const redacted = redactSensitiveData({
      ...payload,
      runId: payload?.runId || runId,
      timestamp,
    }) as AgentEvent;
    const traceRef = assembler.consume(redacted);
    const event = {
      ...redacted,
      trace_id: traceRef.trace_id,
      span_id: traceRef.span_id,
      ...(traceRef.parent_id ? { parent_id: traceRef.parent_id } : {}),
    } as AgentEvent;

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
