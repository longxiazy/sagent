/**
 * Suggestions API — 主页"试试这些任务/问题"建议数据 + 使用记录
 *
 * GET  /api/suggestions          → { chat, agent } (agent 顶部带"最近使用"分类)
 * POST /api/suggestions/use      → { ok: true },累计 uses + lastUsedAt
 */

import { Router } from 'express';
import type { SuggestionStore } from '../helpers/suggestion-store.ts';
import { pickLocale, tReq } from '../helpers/i18n.ts';

export function createSuggestionsRouter({ store }: { store: SuggestionStore }) {
  const router = Router();

  router.get('/api/suggestions', async (req, res) => {
    try {
      const data = await store.getMerged(pickLocale(req));
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/suggestions/use', async (req, res) => {
    const { title, text } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: tReq(req, 'suggestions.textEmpty') });
    }
    try {
      await store.recordUse({
        title: String(title ?? '').slice(0, 32),
        text,
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
