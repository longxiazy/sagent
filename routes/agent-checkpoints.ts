import { Router } from 'express';
import { listSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { log } from '../helpers/logger.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentCheckpointRouter({ checkpointDir, agentRunStore }: AgentRouterContext) {
  const router = Router();

  router.get('/api/agent/checkpoints', async (req, res) => {
    if (!checkpointDir) {
      return res.json({ checkpoints: [] });
    }
    const queryRunId = req.query.runId;
    const activeRun = agentRunStore.getActiveRun();
    const runId = queryRunId || activeRun?.runId;
    if (!runId) {
      return res.json({ checkpoints: [] });
    }
    try {
      const checkpoints = await listSessionCheckpoints(checkpointDir, runId);
      return res.json({ runId, checkpoints });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/agent/rollback', (req, res) => {
    const { targetStep } = req.body ?? {};
    if (typeof targetStep !== 'number' || !Number.isInteger(targetStep) || targetStep < 1) {
      return res.status(400).json({ error: 'targetStep 必须是正整数' });
    }
    if (!checkpointDir) {
      return res.status(400).json({ error: '会话检查点未启用' });
    }
    const activeRun = agentRunStore.getActiveRun();
    if (!activeRun) {
      return res.status(404).json({ error: '没有活跃的运行' });
    }
    if (activeRun.rolledBack) {
      return res.status(409).json({ error: '已有回滚请求处理中' });
    }
    activeRun.pendingRollback = targetStep;
    log.info(`[API] 设置回滚请求: runId=${activeRun.runId} targetStep=${targetStep}`);
    return res.json({ ok: true, runId: activeRun.runId, targetStep });
  });

  return router;
}
