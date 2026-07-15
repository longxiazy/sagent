import { safeJson, cleanText, displayWidth, padEndW } from '../agent/core/utils.ts';
import { formatLogTime, buildAgentMetrics, buildSseWriter, logAgentEvent } from '../helpers/agent-logging.ts';
import { createBaseEventSender } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import type { Request, Response } from 'express';
import type { AgentEvent, AgentRunStore, ApprovalStore } from '../agent/core/contracts.ts';

export interface AgentRunTrackingState {
  completedStepCount: number;
  observedStepCount: number;
  modelsUsed: string[];
  modelUsage: Record<string, number>;
  stepModels: Record<number, string>;
}

export interface AgentRunSession {
  sendEvent(payload: AgentEvent): void;
  getTrackingState(): AgentRunTrackingState;
  close(args: { finalAnswer: string | null; agentError: Error | null; approvalStore: ApprovalStore }): void;
}

export function createAgentRunSession({
  req,
  res,
  model,
  agentHeadless,
  normalizedTask,
  agentModels,
  strategy,
  sessionId,
  projectId,
  runId,
  attempt,
  startedAt,
  agentRunStore,
  memoryDir,
}: {
  req: Request;
  res: Response;
  model: string;
  agentHeadless: boolean;
  normalizedTask: string;
  agentModels: string[];
  strategy: string;
  sessionId: string | null;
  projectId: string | null;
  runId: string;
  attempt: number;
  startedAt: number;
  agentRunStore: AgentRunStore;
  memoryDir?: string;
}) {
  let completedStepCount = 0;
  let observedStepCount = 0;
  const modelsUsed = new Set<string>();
  const modelUsageCounts = new Map<string, number>();
  const stepModels: Record<number, string> = {};
  let sseClosed = false;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  const heartbeat = setInterval(() => {
    if (!sseClosed && !res.writableEnded) {
      try { res.write(': heartbeat\n\n'); } catch { sseClosed = true; clearInterval(heartbeat); }
    }
  }, 15000);

  req.on('close', () => {
    if (sseClosed) return;
    sseClosed = true;
    clearInterval(heartbeat);
    log.debug(`[${formatLogTime()}] POST /api/agent client_disconnected model=${model} run_id=${runId}`);
  });

  log.info(
    `[${formatLogTime()}] POST /api/agent model=${model} headless=${agentHeadless} task=${safeJson(normalizedTask)} ` +
      `run_id=${runId}`
  );

  const rawSendEvent = buildSseWriter(res);
  const baseSendEvent = createBaseEventSender(runId, agentRunStore, memoryDir);
  const sendEvent = (payload: AgentEvent) => {
    const attemptPayload = { ...payload, attempt } as AgentEvent;
    if (attemptPayload.type === 'step') {
      observedStepCount = Math.max(observedStepCount, attemptPayload.step || 0);
      if (attemptPayload.stage === 'result') {
        completedStepCount = Math.max(completedStepCount, attemptPayload.step || 0);
      }
    }
    if (attemptPayload.type === 'model_plan' && attemptPayload.stage === 'winner' && attemptPayload.step) {
      stepModels[attemptPayload.step] = attemptPayload.model;
      if (attemptPayload.model) {
        modelUsageCounts.set(attemptPayload.model, (modelUsageCounts.get(attemptPayload.model) || 0) + 1);
      }
    }
    if (attemptPayload.type === 'model_plan' && attemptPayload.model && ['winner', 'success', 'thinking'].includes(attemptPayload.stage)) {
      modelsUsed.add(attemptPayload.model);
    }
    logAgentEvent(attemptPayload);
    const event = baseSendEvent(attemptPayload);
    if (!sseClosed && !res.writableEnded) {
      try { rawSendEvent(event); } catch { sseClosed = true; }
    }
  };

  sendEvent({
    type: 'status',
    status: 'starting',
    runId,
    message: tReq(req, 'run.preparing'),
  });
  sendEvent({
    type: 'run_meta',
    runId,
    startedAt,
    model,
    agentModels,
    strategy,
    task: normalizedTask,
    sessionId: sessionId || undefined,
    projectId,
  });
  log.debug(`[SSE] stream started, writableEnded=${res.writableEnded} writableFinished=${res.writableFinished}`);

  function getTrackingState(): AgentRunTrackingState {
    return {
      completedStepCount,
      observedStepCount,
      modelsUsed: [...modelsUsed],
      modelUsage: Object.fromEntries(modelUsageCounts),
      stepModels,
    };
  }

  function close({ finalAnswer, agentError, approvalStore }: { finalAnswer: string | null; agentError: Error | null; approvalStore: ApprovalStore }) {
    const status = agentError
      ? agentError.message === 'Agent 已取消'
        ? 'cancelled'
        : 'error'
      : 'done';
    const metrics = buildAgentMetrics(startedAt, {
      stepCount: Math.max(completedStepCount, observedStepCount),
      status,
    });

    const modelSummaryEntries = [...modelUsageCounts.entries()];
    for (const m of modelsUsed) {
      if (!modelUsageCounts.has(m as string)) {
        modelSummaryEntries.push([m as string, 0]);
      }
    }
    const usedModels = modelSummaryEntries
      .sort((a, b) => b[1] - a[1])
      .map(([fullName, count]) => {
        const shortName = fullName.split('/').pop();
        return count > 0 ? `${shortName}×${count}` : `${shortName}`;
      })
      .join(', ');
    const statusIcon = status === 'done' ? '✅' : status === 'cancelled' ? '⛔' : '❌';
    const elapsedSec = (metrics.elapsed_ms / 1000).toFixed(1);
    const statusLine = `  ${statusIcon} Agent ${status.toUpperCase()}  ${elapsedSec}s  ${metrics.step_count} steps  ${usedModels}`;
    const runLine = `  run: ${runId}`;
    const answerLine = finalAnswer ? `  answer: ${safeJson(cleanText(finalAnswer, 80))}` : '';
    const errorLine = agentError ? `  error: ${safeJson(agentError.message)}` : '';
    const innerLines = [statusLine, runLine, answerLine, errorLine].filter(Boolean);
    const W = Math.max(...innerLines.map(displayWidth)) + 4;
    const bRow = `  ${'═'.repeat(W)}`;
    const box = [
      `  ╔${bRow.slice(2)}╗`,
      ...innerLines.map(line => `  ║${padEndW(line, W)}║`),
      `  ╚${bRow.slice(2)}╝`,
    ].join('\n');
    log.info(`\n${box}`);
    clearInterval(heartbeat);
    approvalStore.rejectAll();
    if (!sseClosed && !res.writableEnded) {
      try { res.end(); } catch {}
    }
    sseClosed = true;
  }

  return { sendEvent, getTrackingState, close } satisfies AgentRunSession;
}
