import { Router } from 'express';
import { tReq } from '../helpers/i18n.ts';
import { ApprovalNotFoundError, ApprovalRunMismatchError } from '../agent/core/approval-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentApprovalRouter({ approvalStore }: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/approvals', (req, res, next) => {
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
      approvalStore.resolve(approvalId, decision, runId);
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof ApprovalRunMismatchError) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      if (!(err instanceof ApprovalNotFoundError)) return next(err);
      // Approval may have been cleared by rejectAll() after run ended
      return res.json({ ok: true, stale: true });
    }
  });

  router.post('/api/agent/question', (req, res, next) => {
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
      approvalStore.resolve(approvalId, response.trim(), runId);
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof ApprovalRunMismatchError) {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      if (!(err instanceof ApprovalNotFoundError)) return next(err);
      return res.json({ ok: true, stale: true });
    }
  });

  return router;
}
