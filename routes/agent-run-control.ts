import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';
import { removeCheckpoint, removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { log } from '../helpers/logger.ts';

export function createAgentRunControlRouter({ agentRunStore, approvalStore, checkpointDir }: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/cancel', async (req, res) => {
    const { runId } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }
    log.warn(`[Cancel] 用户手动停止任务 runId=${runId}`);
    agentRunStore.cancelRun(runId);
    log.warn(`[Cancel] cancelRun 完成 runId=${runId}`);
    approvalStore.rejectAll();
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
    return res.json({ ok: true });
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

  router.get('/api/agent/stream/:runId', (req, res) => {
    const { runId } = req.params;
    const run = agentRunStore.getRun(runId);
    if (!run) {
      return res.status(404).json({ error: '运行不存在' });
    }

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

    const replayCount = run.events.length;
    for (let i = 0; i < replayCount; i++) {
      res.write(`data: ${JSON.stringify(run.events[i])}\n\n`);
    }

    if (run.status !== 'running' || run.cancelAc.signal.aborted) {
      res.end();
    }
    return;
  });

  return router;
}
