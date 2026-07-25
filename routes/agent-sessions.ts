import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentSessionsRouter({ sessionStore }: AgentRouterContext) {
  const router = Router();

  // 隐私模式允许读取已有会话供页面显示，但所有会改变 chat-sessions.json 的
  // 请求都转成只读操作。X-Private-Mode 是前端主路径，body/query 仅保留兼容。
  const isPrivateRequest = (req: any) => (
    req.get('X-Private-Mode') === 'true'
    || req.body?.privateMode === true
    || req.query?.privateMode === 'true'
  );

  router.get('/api/sessions', async (req, res) => {
    try {
      return res.json(await sessionStore.loadAll({ persist: !isPrivateRequest(req) }));
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
      return res.json(await sessionStore.upsertSession(
        { ...session, id: req.params.id },
        { persist: !isPrivateRequest(req) },
      ));
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || String(err) });
    }
  });

  router.delete('/api/sessions/:id', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
      return res.json(await sessionStore.deleteSession(
        projectId,
        req.params.id,
        { persist: !isPrivateRequest(req) },
      ));
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
