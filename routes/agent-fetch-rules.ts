import { Router } from 'express';
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
      return res.status(400).json({ error: 'Domain rules 未启用' });
    }
    const { domain } = req.body ?? {};
    if (typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'domain 不能为空' });
    }
    await domainRules.addDomain(domain.trim());
    return res.json({ ok: true });
  });

  router.delete('/api/agent/fetch-rules', async (req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: 'Domain rules 未启用' });
    }
    const { domain } = req.body ?? {};
    if (typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'domain 不能为空' });
    }
    await domainRules.removeDomain(domain.trim());
    return res.json({ ok: true });
  });

  router.post('/api/agent/fetch-rules/reset', async (_req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: 'Domain rules 未启用' });
    }
    await domainRules.resetToDefaults();
    return res.json({ ok: true });
  });

  return router;
}
