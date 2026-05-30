import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';
import { removeCheckpoint, removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { readTraceEvents } from '../helpers/trace-store.ts';
import { log } from '../helpers/logger.ts';

const RUN_ID_RE = /^run_[a-z0-9]+_[a-z0-9]+$/i;

/**
 * 取消运行：abort run、拒绝所有待审批、清理 checkpoint。
 * 供 POST /api/agent/cancel 和 POST /api/agent/:runId/cancel 共用。
 */
async function cancelRunById(
  runId: string,
  { agentRunStore, approvalStore, checkpointDir }: Pick<AgentRouterContext, 'agentRunStore' | 'approvalStore' | 'checkpointDir'>,
) {
  log.warn(`[Cancel] 用户手动停止任务 runId=${runId}`);
  agentRunStore.cancelRun(runId);
  log.warn(`[Cancel] cancelRun 完成 runId=${runId}`);
  approvalStore.rejectAll(runId);
  log.warn(`[Cancel] rejectAll 完成 runId=${runId}`);
  // 立即清理 checkpoint，防止重启后恢复已取消的任务
  try {
    await Promise.all([
      removeCheckpoint(checkpointDir, runId),
      removeSessionCheckpoints(checkpointDir, runId),
    ]);
    log.warn(`[Cancel] checkpoint 清理完成 runId=${runId}`);
  } catch (err: any) {
    log.warn(`[Cancel] checkpoint 清理失败 runId=${runId}: ${err.message}`);
  }
}

/**
 * 从一串 SSE 事件里派生轻量进度：步数、是否完成、最终答案/错误。
 * 内存 run.events 和磁盘 trace 事件结构一致，两条路共用。
 */
function deriveProgressFromEvents(events: any[]) {
  let step = 0;
  let answer: string | null = null;
  let error: string | null = null;
  let done = false;
  let errored = false;
  for (const event of events) {
    if (event.type === 'step' && typeof event.step === 'number') {
      step = Math.max(step, event.step);
    } else if (event.type === 'done') {
      done = true;
      answer = event.answer ?? null;
    } else if (event.type === 'error') {
      errored = true;
      error = event.error ?? null;
    }
  }
  return { step, answer, error, done, errored };
}

export function createAgentRunControlRouter({ agentRunStore, approvalStore, checkpointDir, memoryDir }: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/cancel', async (req, res) => {
    const { runId } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }
    await cancelRunById(runId, { agentRunStore, approvalStore, checkpointDir });
    return res.json({ ok: true });
  });

  // RESTful alias，等价于 POST /api/agent/cancel（旧端点保留，前端不改）
  router.post('/api/agent/:runId/cancel', async (req, res) => {
    const { runId } = req.params;
    if (!RUN_ID_RE.test(runId)) {
      return res.status(400).json({ error: 'runId 格式无效' });
    }
    await cancelRunById(runId, { agentRunStore, approvalStore, checkpointDir });
    return res.json({ ok: true });
  });

  // 轻量状态查询：后台任务提交后用它轮询进度，不需要挂 SSE 长连接。
  router.get('/api/agent/:runId/status', (req, res) => {
    (async () => {
      const { runId } = req.params;
      if (!RUN_ID_RE.test(runId)) {
        return res.status(400).json({ error: 'runId 格式无效' });
      }

      const run = agentRunStore.getRun(runId);
      if (run) {
        const progress = deriveProgressFromEvents(run.events || []);
        const cancelled = run.cancelAc?.signal?.aborted ?? false;
        const status = progress.done
          ? 'done'
          : progress.errored
            ? 'error'
            : cancelled
              ? 'cancelled'
              : run.status === 'running'
                ? 'running'
                : run.status;
        return res.json({
          runId,
          status,
          startedAt: run.startedAt,
          model: run.meta?.model,
          task: run.meta?.task,
          step: progress.step,
          done: progress.done || progress.errored || cancelled,
          ...(progress.answer != null ? { answer: progress.answer } : {}),
          ...(progress.error != null ? { error: progress.error } : {}),
        });
      }

      // run 记录已过 TTL（5min）从内存清掉，回退到磁盘 trace
      const traceEvents = await readTraceEvents(memoryDir, runId);
      if (traceEvents.length === 0) {
        return res.status(404).json({ error: '运行不存在' });
      }
      const progress = deriveProgressFromEvents(traceEvents);
      const meta = traceEvents.find((event: any) => event.type === 'run_meta');
      const status = progress.errored ? 'error' : 'done';
      return res.json({
        runId,
        status,
        startedAt: meta?.startedAt,
        model: meta?.model,
        task: meta?.task,
        step: progress.step,
        done: true,
        ...(progress.answer != null ? { answer: progress.answer } : {}),
        ...(progress.error != null ? { error: progress.error } : {}),
      });
    })().catch((err: any) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  });

  router.get('/api/agent/active', (_req, res) => {
    const run = agentRunStore.getActiveRun();
    if (!run) {
      return res.json({ active: false });
    }
    return res.json({
      active: true,
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      task: run.meta?.task,
      meta: run.meta,
    });
  });

  // 列出所有正在运行的任务（并发模式下可能多个），供前端重连时逐个恢复。
  router.get('/api/agent/runs', (_req, res) => {
    const runs = agentRunStore.listActiveRuns().map((run: any) => ({
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      task: run.meta?.task,
    }));
    return res.json({ runs });
  });

  router.get('/api/agent/stream/:runId', (req, res) => {
    (async () => {
    const { runId } = req.params;
    const run = agentRunStore.getRun(runId);
    if (!run) {
      const traceEvents = await readTraceEvents(memoryDir, runId);
      if (traceEvents.length === 0) {
        return res.status(404).json({ error: '运行不存在' });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.socket?.setNoDelay(true);

      for (const event of traceEvents) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
      return;
    }
    await Promise.allSettled(run.traceWrites || []);

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
      task: run.meta?.task,
    })}\n\n`);

    let writer = null;
    if (run.status === 'running' && !run.cancelAc.signal.aborted) {
      writer = (payload: any) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };
      run._reconnectWriters = run._reconnectWriters || [];
      run._reconnectWriters.push(writer);

      req.on('close', () => {
        if (run._reconnectWriters) {
          run._reconnectWriters = run._reconnectWriters.filter((reconnectWriter: any) => reconnectWriter !== writer);
        }
      });
    }

    const traceEvents = await readTraceEvents(memoryDir, runId);
    const replayEvents = traceEvents.length > 0 ? traceEvents : run.events;
    for (const event of replayEvents) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (run.status !== 'running' || run.cancelAc.signal.aborted) {
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
