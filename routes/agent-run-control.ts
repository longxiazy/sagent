import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';
import { removeCheckpoint, removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { readTraceEvents } from '../helpers/trace-store.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import { ACTIVE_RUN_STATUSES, type AgentEvent, type ApprovalStore } from '../agent/core/contracts.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';

function pendingApprovalState(approvalStore: ApprovalStore, runId: string) {
  const pending = approvalStore.listPendingForRun(runId);
  return {
    pendingApproval: pending.find(item => item.type === 'approval_required') || null,
    pendingQuestion: pending.find(item => item.type === 'question_required') || null,
    pendingEvents: pending,
  };
}

function parseCursor(req): number {
  const raw = typeof req.query.cursor === 'string' ? req.query.cursor : req.get('last-event-id');
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function ensureEventSequences(events: AgentEvent[]): AgentEvent[] {
  let nextSeq = 1;
  return events.map(event => {
    if (Number.isFinite(event.seq)) {
      nextSeq = Math.max(nextSeq, Number(event.seq) + 1);
      return event;
    }
    return { ...event, seq: nextSeq++ } as AgentEvent;
  });
}

function writeSseEvent(res, event: AgentEvent) {
  const idLine = Number.isFinite(event.seq) ? `id: ${event.seq}\n` : '';
  res.write(`${idLine}data: ${JSON.stringify(event)}\n\n`);
}

export function createAgentRunControlRouter({ agentRunStore, approvalStore, checkpointDir, memoryDir, projectStore }: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/cancel', async (req, res) => {
    const { runId } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: tReq(req, 'approval.runIdEmpty') });
    }
    log.warn(`[Cancel] 用户手动停止任务 runId=${runId}`);
    const run = agentRunStore.getRun(runId);
    agentRunStore.cancelRun(runId);
    log.warn(`[Cancel] cancelRun 完成 runId=${runId}`);
    approvalStore.rejectAll();
    log.warn(`[Cancel] rejectAll 完成 runId=${runId}`);
    // 立即清理 checkpoint，防止重启后恢复已取消的任务
    try {
      const removeCancelledCheckpoints = () => Promise.all([
        removeCheckpoint(run?.meta?.dataDir || checkpointDir, runId),
        removeSessionCheckpoints(run?.meta?.dataDir || checkpointDir, runId),
      ]);
      if (run?.persistence) await run.persistence.enqueue(removeCancelledCheckpoints);
      else await removeCancelledCheckpoints();
      log.warn(`[Cancel] checkpoint 清理完成 runId=${runId}`);
    } catch (err: any) {
      log.warn(`[Cancel] checkpoint 清理失败 runId=${runId}: ${err.message}`);
    }
    return res.json({ ok: true });
  });

  router.get('/api/agent/active', (_req, res) => {
    const run = agentRunStore.getActiveRun();
    if (!run) {
      return res.json({ active: false });
    }
    const pending = pendingApprovalState(approvalStore, run.runId);
    return res.json({
      active: true,
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      task: run.meta?.task,
      meta: run.meta,
      pendingApproval: pending.pendingApproval,
      pendingQuestion: pending.pendingQuestion,
    });
  });

  router.get('/api/agent/stream/:runId', (req, res) => {
    (async () => {
    const { runId } = req.params;
    const cursor = parseCursor(req);
    const run = agentRunStore.getRun(runId);
    if (!run) {
      const pid = typeof req.query.projectId === 'string' ? req.query.projectId : null;
      const traceDir = resolveRunPaths(projectStore, pid, memoryDir).dataDir;
      const traceEvents = await readTraceEvents(traceDir, runId);
      if (traceEvents.length === 0) {
        return res.status(404).json({ error: tReq(req, 'run.notFound') });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.socket?.setNoDelay(true);

      for (const event of ensureEventSequences(traceEvents).filter(event => Number(event.seq) > cursor)) {
        writeSseEvent(res, event);
      }
      res.end();
      return;
    }
    await run.persistence?.flush();
    const replayUpperSeq = run.nextEventSeq - 1;
    let replaying = true;
    const liveBuffer: AgentEvent[] = [];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    res.write(`data: ${JSON.stringify({
      type: 'run_meta',
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      agentModels: run.meta?.agentModels,
      task: run.meta?.task,
      sessionId: run.meta?.sessionId,
      projectId: run.meta?.projectId ?? null,
      strategy: run.meta?.strategy,
      attempt: run.meta?.attempt,
    })}\n\n`);

    let writer = null;
    if (ACTIVE_RUN_STATUSES.has(run.status)) {
      writer = (payload: AgentEvent) => {
        if (Number(payload.seq) <= cursor) return;
        if (replaying) liveBuffer.push(payload);
        else if (!res.writableEnded) writeSseEvent(res, payload);
      };
      run._reconnectWriters = run._reconnectWriters || [];
      run._reconnectWriters.push(writer);

      req.on('close', () => {
        if (run._reconnectWriters) {
          run._reconnectWriters = run._reconnectWriters.filter(reconnectWriter => reconnectWriter !== writer);
        }
      });
    }

    const traceEvents = await readTraceEvents(run.meta?.dataDir || memoryDir, runId);
    const replayEvents = ensureEventSequences(traceEvents.length > 0 ? traceEvents : run.events)
      .filter(event => Number(event.seq) > cursor && Number(event.seq) <= replayUpperSeq);
    for (const event of replayEvents) {
      writeSseEvent(res, event);
    }

    if (cursor === 0) {
      const replayedApprovalIds = new Set(replayEvents.map((event: any) => event.approvalId).filter(Boolean));
      const pending = pendingApprovalState(approvalStore, run.runId);
      for (const event of pending.pendingEvents) {
        if (!replayedApprovalIds.has(event.approvalId)) {
          writeSseEvent(res, { ...event, attempt: run.meta?.attempt } as AgentEvent);
        }
      }
    }

    replaying = false;
    liveBuffer
      .filter(event => Number(event.seq) > Math.max(cursor, replayUpperSeq))
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .forEach(event => {
        if (!res.writableEnded) writeSseEvent(res, event);
      });

    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      res.end();
    }
    return;
    })().catch((err: any) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  return router;
}
