import { Router } from 'express';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentApprovalRouter({ approvalStore }: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/approvals', (req, res) => {
    const { runId, approvalId, decision } = req.body ?? {};

    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: tReq(req, 'approval.runIdEmpty') });
    }

    if (typeof approvalId !== 'string' || !approvalId) {
      return res.status(400).json({ error: tReq(req, 'approval.approvalIdEmpty') });
    }

    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: tReq(req, 'approval.decisionInvalid') });
    }

    try {
      approvalStore.resolve(approvalId, decision);
      return res.json({ ok: true });
    } catch {
      // Approval may have been cleared by rejectAll() after run ended
      return res.json({ ok: true, stale: true });
    }
  });

  router.post('/api/agent/question', (req, res) => {
    const { runId, approvalId, response } = req.body ?? {};

    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: tReq(req, 'approval.runIdEmpty') });
    }

    if (typeof approvalId !== 'string' || !approvalId) {
      return res.status(400).json({ error: tReq(req, 'approval.approvalIdEmpty') });
    }

    if (typeof response !== 'string') {
      return res.status(400).json({ error: tReq(req, 'approval.responseMustBeString') });
    }

    try {
      approvalStore.resolve(approvalId, response.trim());
      return res.json({ ok: true });
    } catch {
      return res.json({ ok: true, stale: true });
    }
  });

  return router;
}
