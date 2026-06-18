import { Router } from 'express';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentFetchRulesRouter({ domainRules }: AgentRouterContext) {
  const router = Router();

  router.get('/api/agent/fetch-rules', async (_req, res) => {
    if (!domainRules) {
      return res.json({ domains: [] });
    }
    const domains = await domainRules.getRules();
    return res.json({ domains });
  });

  router.post('/api/agent/fetch-rules', async (req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: tReq(req, 'fetchRules.notEnabled') });
    }
    const { domain } = req.body ?? {};
    if (typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: tReq(req, 'fetchRules.domainEmpty') });
    }
    await domainRules.addDomain(domain.trim());
    return res.json({ ok: true });
  });

  router.delete('/api/agent/fetch-rules', async (req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: tReq(req, 'fetchRules.notEnabled') });
    }
    const { domain } = req.body ?? {};
    if (typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: tReq(req, 'fetchRules.domainEmpty') });
    }
    await domainRules.removeDomain(domain.trim());
    return res.json({ ok: true });
  });

  router.post('/api/agent/fetch-rules/reset', async (req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: tReq(req, 'fetchRules.notEnabled') });
    }
    await domainRules.resetToDefaults();
    return res.json({ ok: true });
  });

  return router;
}
