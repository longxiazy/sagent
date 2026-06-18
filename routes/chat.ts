import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { log } from '../helpers/logger.ts';
import { initSse, writeSse } from '../helpers/streaming.ts';
import { tReq } from '../helpers/i18n.ts';
import type { ProviderRegistry } from '../agent/core/providers/registry.ts';

export function createChatRouter({ registry, modelConfig }: { registry: ProviderRegistry; modelConfig: any[] }) {
  const router = Router();
  const defaultModel = modelConfig?.[0]?.id || 'minimaxai/minimax-m2.7';

  router.post('/api/chat', async (req, res) => {
    const {
      messages,
      model = defaultModel,
      temperature = 1,
      top_p = 0.95,
      max_tokens = 8192,
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: tReq(req, 'chat.messagesMustBeArray') });
    }

    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const startedAt = Date.now();
    log.info(`[${time}] POST /api/chat model=${model} messages=${safeJson(messages)}`);

    initSse(res);

    try {
      const provider = registry.resolve(model, modelConfig);
      await provider.chatStream({ model, messages, temperature, top_p, max_tokens, res, startedAt });
    } catch (err: any) {
      log.error('API error:', err);
      writeSse(res, { error: err.message });
    } finally {
      res.end();
    }
    return;
  });

  return router;
}
