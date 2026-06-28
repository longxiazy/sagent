import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { buildOpenAiError } from '../helpers/streaming.ts';
import { log } from '../helpers/logger.ts';
import type { ProviderRegistry } from '../agent/core/providers/registry.ts';

export function createCompletionsRouter({ registry, modelConfig }: { registry: ProviderRegistry; modelConfig: any[] }) {
  const router = Router();

  router.get('/api/models', (_req, res) => {
    res.json({ models: modelConfig });
  });

  router.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: modelConfig.map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.provider || 'unknown',
      })),
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    const {
      model,
      messages,
      temperature = 1,
      top_p = 0.95,
      max_tokens = 8192,
      stream = false,
    } = req.body ?? {};

    if (!Array.isArray(messages)) {
      const error = buildOpenAiError('messages must be an array', 'invalid_request_error', 400);
      return res.status(error.status).json(error.body);
    }

    if (typeof model !== 'string' || !model.trim()) {
      const error = buildOpenAiError('model is required', 'invalid_request_error', 400);
      return res.status(error.status).json(error.body);
    }

    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    log.info(`[${time}] POST /v1/chat/completions model=${model} stream=${Boolean(stream)} messages=${safeJson(messages)}`);

    try {
      const provider = registry.resolve(model, modelConfig);

      if (!stream) {
        return res.json(await provider.completionJson({ model, messages, temperature, top_p, max_tokens }));
      }
      return await provider.completionStream({ model, messages, temperature, top_p, max_tokens, res });
    } catch (err: any) {
      log.error('API error:', err);

      const error = buildOpenAiError(err.message);
      if (stream && res.headersSent) {
        writeCompletionStreamError(res, err);
        return;
      }
      return res.status(error.status).json(error.body);
    }
  });

  router.get('/health', (_, res) =>
    res.json({
      status: 'ok',
      browser_agent: 'enabled',
    })
  );

  return router;
}

function writeCompletionStreamError(res: any, err: any) {
  const error = buildOpenAiError(err.message);
  res.write(`data: ${JSON.stringify(error.body)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
