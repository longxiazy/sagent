import { Router } from 'express';
import { listSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentCheckpointRouter({ checkpointDir, agentRunStore, memoryDir, projectStore }: AgentRouterContext) {
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
    // 会话快照目录优先取 run 记录里的 dataDir；否则按 ?projectId 解析；都没有回退全局。
    const run = agentRunStore.getRun(runId);
    const pid = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const dir = run?.meta?.dataDir || resolveRunPaths(projectStore, pid, memoryDir).dataDir;
    try {
      const checkpoints = await listSessionCheckpoints(dir, runId);
      return res.json({ runId, checkpoints });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/agent/rollback', (req, res) => {
    const { targetStep } = req.body ?? {};
    if (typeof targetStep !== 'number' || !Number.isInteger(targetStep) || targetStep < 1) {
      return res.status(400).json({ error: tReq(req, 'checkpoint.targetStepInvalid') });
    }
    if (!checkpointDir) {
      return res.status(400).json({ error: tReq(req, 'checkpoint.notEnabled') });
    }
    const activeRun = agentRunStore.getActiveRun();
    if (!activeRun) {
      return res.status(404).json({ error: tReq(req, 'checkpoint.noActiveRun') });
    }
    if (activeRun.rolledBack) {
      return res.status(409).json({ error: tReq(req, 'checkpoint.rollbackInProgress') });
    }
    activeRun.pendingRollback = targetStep;
    log.info(`[API] 设置回滚请求: runId=${activeRun.runId} targetStep=${targetStep}`);
    return res.json({ ok: true, runId: activeRun.runId, targetStep });
  });

  return router;
}
