import { safeJson, cleanText, displayWidth, padEndW } from '../agent/core/utils.ts';
import { formatLogTime, buildAgentMetrics, buildSseWriter, logAgentEvent } from '../helpers/agent-logging.ts';
import { createBaseEventSender } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';

export function createAgentRunSession({
  req,
  res,
  model,
  agentHeadless,
  normalizedTask,
  runId,
  startedAt,
  agentRunStore,
}: {
  req: any;
  res: any;
  model: string;
  agentHeadless: boolean;
  normalizedTask: string;
  runId: string;
  startedAt: number;
  agentRunStore: any;
}) {
  let completedStepCount = 0;
  let observedStepCount = 0;
  const modelsUsed = new Set();
  const stepModels: Record<number, string> = {};

  req.on('close', () => {
    if (!res.writableEnded) {
      log.debug(`[${formatLogTime()}] POST /api/agent client_disconnected model=${model} run_id=${runId}`);
    }
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15000);

  log.info(
    `[${formatLogTime()}] POST /api/agent model=${model} headless=${agentHeadless} task=${safeJson(normalizedTask)} ` +
      `run_id=${runId}`
  );

  const rawSendEvent = buildSseWriter(res);
  const baseSendEvent = createBaseEventSender(runId, agentRunStore);
  const sendEvent = (payload: any) => {
    if (payload.type === 'step') {
      observedStepCount = Math.max(observedStepCount, payload.step || 0);
      if (payload.stage === 'result') {
        completedStepCount = Math.max(completedStepCount, payload.step || 0);
      }
    }
    if (payload.type === 'model_plan' && payload.stage === 'winner' && payload.step) {
      stepModels[payload.step] = payload.model;
    }
    if (payload.type === 'model_plan' && payload.model && ['winner', 'success', 'thinking'].includes(payload.stage)) {
      modelsUsed.add(payload.model);
    }
    logAgentEvent(payload);
    baseSendEvent(payload);
    if (payload.type === 'model_plan' || payload.type === 'session_checkpoint') {
      log.debug(`[SSE] write type=${payload.type} step=${payload.step} stage=${payload.stage ?? '-'} model=${payload.model ?? '-'} writableEnded=${res.writableEnded} writableFinished=${res.writableFinished}`);
    }
    rawSendEvent(payload);
  };

  sendEvent({
    type: 'status',
    status: 'starting',
    runId,
    message: '准备启动桌面 Agent',
  });
  log.debug(`[SSE] stream started, writableEnded=${res.writableEnded} writableFinished=${res.writableFinished}`);

  function getTrackingState() {
    return {
      completedStepCount,
      observedStepCount,
      modelsUsed: [...modelsUsed],
      stepModels,
    };
  }

  function close({ finalAnswer, agentError, approvalStore }: { finalAnswer: string | null; agentError: any; approvalStore: any }) {
    const status = agentError
      ? agentError.message === 'Agent 已取消'
        ? 'cancelled'
        : 'error'
      : 'done';
    const metrics = buildAgentMetrics(startedAt, {
      stepCount: Math.max(completedStepCount, observedStepCount),
      status,
    });

    const usedModels = [...modelsUsed].map((selectedModel: any) => (selectedModel as string).split('/').pop()).join(',');
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
    res.end();
  }

  return { sendEvent, getTrackingState, close };
}
