import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentApprovalRouter({ approvalStore }: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/approvals', (req, res) => {
    const { runId, approvalId, decision } = req.body ?? {};

    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }

    if (typeof approvalId !== 'string' || !approvalId) {
      return res.status(400).json({ error: 'approvalId 不能为空' });
    }

    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision 必须是 approve 或 reject' });
    }

    try {
      approvalStore.resolve(approvalId, decision);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }
  });

  router.post('/api/agent/question', (req, res) => {
    const { runId, approvalId, response } = req.body ?? {};

    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }

    if (typeof approvalId !== 'string' || !approvalId) {
      return res.status(400).json({ error: 'approvalId 不能为空' });
    }

    if (typeof response !== 'string') {
      return res.status(400).json({ error: 'response 必须是字符串' });
    }

    try {
      approvalStore.resolve(approvalId, response.trim());
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }
  });

  return router;
}
