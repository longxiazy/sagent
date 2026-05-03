import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { isClaudeModel } from '../agent/core/ai-client.ts';
import { buildOpenAiError, createStreamingCompletionFactory } from '../helpers/streaming.ts';
import { log } from '../helpers/logger.ts';

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
      if (isClaudeModel(model, modelConfig) && !anthropic_client) throw new Error('未配置 ANTHROPIC_API_KEY');
      if (!isClaudeModel(model, modelConfig) && !openai_client) throw new Error('未配置 NVIDIA_API_KEY');
      if (!stream) {
        if (isClaudeModel(model, modelConfig)) {
          const response = await anthropic_client.messages.create({
            model,
            max_tokens,
            temperature,
            messages,
          });
          const text = response.content.find(b => b.type === 'text')?.text || '';
          return res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: response.stop_reason || 'stop',
            }],
            usage: {
              prompt_tokens: response.usage?.input_tokens || 0,
              completion_tokens: response.usage?.output_tokens || 0,
              total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
            },
          });
        }
        const completion = await openai_client.chat.completions.create({
          model,
          messages,
          temperature,
          top_p,
          max_tokens,
        });
        return res.json(completion);
      }

      if (isClaudeModel(model, modelConfig)) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        let idx = 0;
        const stream2 = anthropic_client.messages.stream({
          model,
          max_tokens,
          temperature,
          messages,
        });

        for await (const event of stream2) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              res.write(`data: ${JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: idx, delta: { content: event.delta.text }, finish_reason: null }],
              })}\n\n`);
            }
          } else if (event.type === 'message_delta') {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: idx, delta: {}, finish_reason: event.delta?.stop_reason || 'stop' }],
            })}\n\n`);
          }
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const completion = await createStreamingCompletion(
        {
          model,
          messages,
          temperature,
          top_p,
          max_tokens,
        },
        { includeUsage: true }
      );

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      for await (const chunk of completion) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      log.error('API error:', err);

      const error = buildOpenAiError(err.message);
      if (stream && res.headersSent) {
        res.write(`data: ${JSON.stringify(error.body)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
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
