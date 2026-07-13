/**
 * Suggestions API — 主页"试试这些任务/问题"建议数据
 *
 * GET /api/suggestions → { agent }
 */

import { Router } from 'express';
import type { SuggestionStore } from '../helpers/suggestion-store.ts';
import { pickLocale } from '../helpers/i18n.ts';

export function createSuggestionsRouter({ store }: { store: SuggestionStore }) {
  const router = Router();

  router.get('/api/suggestions', async (req, res) => {
    try {
      const data = await store.get(pickLocale(req));
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
