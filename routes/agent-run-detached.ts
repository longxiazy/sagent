import { safeJson } from '../agent/core/utils.ts';
import { formatLogTime } from '../helpers/agent-logging.ts';
import { createBaseEventSender } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import { createRunTracker, logRunSummaryBox } from './agent-run-tracking.ts';

/**
 * 后台(background)运行的 session。
 *
 * 与前台 createAgentRunSession 的区别：没有 res / SSE / heartbeat。
 * 事件只写进 run-store + trace 文件 + reconnect writers（由 createBaseEventSender 负责），
 * 这样后台任务的进度依然能被 GET /api/agent/stream/:runId 重连观察、被 status 端点查询。
 *
 * 暴露与前台 session 相同的 { sendEvent, getTrackingState, close } 契约，
 * 因此可以原样喂给 executeAgentRun。
 */
export function createDetachedAgentRunSession({
  model,
  agentHeadless,
  normalizedTask,
  runId,
  startedAt,
  agentRunStore,
  memoryDir,
}: {
  model: string;
  agentHeadless: boolean;
  normalizedTask: string;
  runId: string;
  startedAt: number;
  agentRunStore: any;
  memoryDir?: string;
}) {
  const tracker = createRunTracker();
  const baseSendEvent = createBaseEventSender(runId, agentRunStore, memoryDir);

  log.info(
    `[${formatLogTime()}] POST /api/agent (background) model=${model} headless=${agentHeadless} ` +
      `task=${safeJson(normalizedTask)} run_id=${runId}`
  );

  const sendEvent = (payload: any) => {
    tracker.track(payload);
    baseSendEvent(payload);
  };

  sendEvent({
    type: 'status',
    status: 'starting',
    runId,
    message: '准备启动桌面 Agent（后台运行）',
  });

  function close({ finalAnswer, agentError, approvalStore }: { finalAnswer: string | null; agentError: any; approvalStore: any }) {
    logRunSummaryBox({ startedAt, runId, finalAnswer, agentError, trackingState: tracker.getTrackingState() });
    approvalStore.rejectAll(runId);
  }

  return { sendEvent, getTrackingState: tracker.getTrackingState, close };
}
