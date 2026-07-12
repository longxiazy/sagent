import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentSessionsRouter({ sessionStore }: AgentRouterContext) {
  const router = Router();

  router.get('/api/sessions', async (_req, res) => {
    try {
      return res.json(await sessionStore.loadAll());
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  router.put('/api/sessions', async (req, res) => {
    try {
      const { sessions, activeSessionId } = req.body ?? {};
      return res.json(await sessionStore.replaceAll(sessions, activeSessionId));
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
