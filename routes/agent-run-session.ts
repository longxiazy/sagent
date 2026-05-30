import { safeJson } from '../agent/core/utils.ts';
import { formatLogTime, buildSseWriter, logAgentEvent } from '../helpers/agent-logging.ts';
import { createBaseEventSender } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import { createRunTracker, logRunSummaryBox } from './agent-run-tracking.ts';

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
  req: any;
  res: any;
  model: string;
  agentHeadless: boolean;
  normalizedTask: string;
  runId: string;
  startedAt: number;
  agentRunStore: any;
  memoryDir?: string;
}) {
  const tracker = createRunTracker();
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
  const sendEvent = (payload: any) => {
    tracker.track(payload);
    logAgentEvent(payload);
    baseSendEvent(payload);
    if (!sseClosed && !res.writableEnded) {
      try { rawSendEvent(payload); } catch { sseClosed = true; }
    }
  };

  sendEvent({
    type: 'status',
    status: 'starting',
    runId,
    message: '准备启动桌面 Agent',
  });
  log.debug(`[SSE] stream started, writableEnded=${res.writableEnded} writableFinished=${res.writableFinished}`);

  const getTrackingState = tracker.getTrackingState;

  function close({ finalAnswer, agentError, approvalStore }: { finalAnswer: string | null; agentError: any; approvalStore: any }) {
    logRunSummaryBox({ startedAt, runId, finalAnswer, agentError, trackingState: tracker.getTrackingState() });
    clearInterval(heartbeat);
    approvalStore.rejectAll(runId);
    if (!sseClosed && !res.writableEnded) {
      try { res.end(); } catch {}
    }
    sseClosed = true;
  }

  return { sendEvent, getTrackingState, close };
}
