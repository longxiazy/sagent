import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { buildOpenAiError, createStreamingCompletionFactory } from '../helpers/streaming.ts';
import { log } from '../helpers/logger.ts';
import {
  handleClaudeCompletionJson,
  handleClaudeCompletionStream,
  handleOpenAiCompletionJson,
  handleOpenAiCompletionStream,
  writeCompletionStreamError,
} from './completions-handlers.ts';
import { requireLlmClient } from './llm-route-utils.ts';

export function createCompletionsRouter({ openai_client, anthropic_client, modelConfig }) {
  const router = Router();
  const createStreamingCompletion = createStreamingCompletionFactory(openai_client);

  const defaultModel = modelConfig[0]?.id || 'minimaxai/minimax-m2.7';

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
        owned_by: m.provider === 'anthropic' ? 'anthropic' : 'nvidia-proxy',
      })),
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    const {
      model = defaultModel,
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

    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    log.info(`[${time}] POST /v1/chat/completions model=${model} stream=${Boolean(stream)} messages=${safeJson(messages)}`);

    try {
      const { useClaude, client } = requireLlmClient({
        model,
        modelConfig,
        openai_client,
        anthropic_client,
      });

      if (!stream) {
        if (useClaude) {
          return res.json(await handleClaudeCompletionJson({
            client,
            model,
            messages,
            max_tokens,
            temperature,
          }));
        }
        return res.json(await handleOpenAiCompletionJson({
          client,
          model,
          messages,
          temperature,
          top_p,
          max_tokens,
        }));
      }

      if (useClaude) {
        return handleClaudeCompletionStream({
          client,
          model,
          messages,
          max_tokens,
          temperature,
          res,
        });
      }

      return handleOpenAiCompletionStream({
        createStreamingCompletion,
        model,
        messages,
        temperature,
        top_p,
        max_tokens,
        res,
      });
    } catch (err: any) {
      log.error('API error:', err);

      const error = buildOpenAiError(err.message);
      if (stream && res.headersSent) {
        return writeCompletionStreamError(res, err);
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
