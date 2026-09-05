import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { buildOpenAiError } from '../helpers/streaming.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import { createModelRefresher, type ModelRefresher } from '../agent/core/providers/model-refresh.ts';
import type { ProviderRegistry } from '../agent/core/providers/registry.ts';

export function createCompletionsRouter({
  registry,
  modelConfig,
  // 默认就地构造：刷新器只在这一个路由里用，构造时刻即启动拉取时刻，
  // server.ts 不必为此多接一根线。
  modelRefresher = createModelRefresher({ registry, modelConfig }),
}: {
  registry: ProviderRegistry;
  modelConfig: any[];
  modelRefresher?: ModelRefresher;
}) {
  const router = Router();

  router.get('/api/models', (_req, res) => {
    res.json({ models: modelConfig, ...modelRefresher.status() });
  });

  // 手动全量重拉。成功即就地替换 modelConfig，所有引用持有者（agent runner、
  // 其他路由）下次读就是新表，不必重启；失败则整体放弃，列表保持原样。
  // 成败与增删差异都由 model-refresh.ts 落日志，这里只管把结果转成 HTTP。
  router.post('/api/models/refresh', async (req, res) => {
    try {
      res.json({ models: modelConfig, ...(await modelRefresher.refresh()) });
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || tReq(req, 'models.refreshFailed'),
        ...modelRefresher.status(),
      });
    }
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
      chat_template_kwargs,
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
        return res.json(await provider.completionJson({ model, messages, temperature, top_p, max_tokens, chat_template_kwargs, preserveReasoningContent: true }));
      }
      return await provider.completionStream({ model, messages, temperature, top_p, max_tokens, chat_template_kwargs, preserveReasoningContent: true, res });
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
