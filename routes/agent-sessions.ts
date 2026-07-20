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

  router.put('/api/sessions/:id', async (req, res) => {
    try {
      const { session } = req.body ?? {};
      if (!session || typeof session !== 'object') {
        return res.status(400).json({ error: 'session 不能为空' });
      }
      return res.json(await sessionStore.upsertSession({ ...session, id: req.params.id }));
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || String(err) });
    }
  });

  router.delete('/api/sessions/:id', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
      return res.json(await sessionStore.deleteSession(projectId, req.params.id));
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
