import { Router } from 'express';
import { readTraceEvents } from '../helpers/trace-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentTraceRouter({ memoryDir, agentRunStore }: AgentRouterContext) {
  const router = Router();

  router.get('/api/agent/traces/:runId', async (req, res) => {
    const { runId } = req.params;
    const run = agentRunStore.getRun(runId);
    await Promise.allSettled(run?.traceWrites || []);
    const events = await readTraceEvents(memoryDir, runId);
    if (events.length === 0) {
      return res.status(404).json({ error: 'trace 不存在' });
    }
    return res.json({ runId, events });
  });

  return router;
}
