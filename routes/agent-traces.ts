import { Router } from 'express';
import { readTraceEvents } from '../helpers/trace-store.ts';
import { tReq } from '../helpers/i18n.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentTraceRouter({ memoryDir, agentRunStore, projectStore }: AgentRouterContext) {
  const router = Router();

  router.get('/api/agent/traces/:runId', async (req, res) => {
    const { runId } = req.params;
    const run = agentRunStore.getRun(runId);
    await run?.persistence?.flush();
    // trace 落盘目录优先取 run 记录里的 dataDir；run 已过期则用 ?projectId 解析；都没有回退全局。
    const pid = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const dir = run?.meta?.dataDir || resolveRunPaths(projectStore, pid, memoryDir).dataDir;
    const events = await readTraceEvents(dir, runId);
    if (events.length === 0) {
      return res.status(404).json({ error: tReq(req, 'trace.notFound') });
    }
    return res.json({ runId, events });
  });

  return router;
}
