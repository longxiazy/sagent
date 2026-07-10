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
  runId,
  startedAt,
  agentRunStore,
  memoryDir,
}: {
  req: Request;
  res: Response;
  model: string;
  agentHeadless: boolean;
  normalizedTask: string;
  runId: string;
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
    if (payload.type === 'step') {
      observedStepCount = Math.max(observedStepCount, payload.step || 0);
      if (payload.stage === 'result') {
        completedStepCount = Math.max(completedStepCount, payload.step || 0);
      }
    }
    if (payload.type === 'model_plan' && payload.stage === 'winner' && payload.step) {
      stepModels[payload.step] = payload.model;
      if (payload.model) {
        modelUsageCounts.set(payload.model, (modelUsageCounts.get(payload.model) || 0) + 1);
      }
    }
    if (payload.type === 'model_plan' && payload.model && ['winner', 'success', 'thinking'].includes(payload.stage)) {
      modelsUsed.add(payload.model);
    }
    logAgentEvent(payload);
    const event = baseSendEvent(payload);
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
