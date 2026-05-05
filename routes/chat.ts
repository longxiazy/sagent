import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { createStreamingCompletionFactory } from '../helpers/streaming.ts';
import { log } from '../helpers/logger.ts';
import { handleClaudeChat, handleNvidiaChat } from './chat-handlers.ts';
import { initSse, requireLlmClient, writeSse } from './llm-route-utils.ts';

export function createChatRouter({ openai_client, anthropic_client, modelConfig }) {
  const router = Router();
  const createStreamingCompletion = createStreamingCompletionFactory(openai_client);
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
      return res.status(400).json({ error: 'messages 字段必须是数组' });
    }

    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const startedAt = Date.now();
    log.info(`[${time}] POST /api/chat model=${model} messages=${safeJson(messages)}`);

    initSse(res);

    try {
      const { useClaude, client } = requireLlmClient({
        model,
        modelConfig,
        openai_client,
        anthropic_client,
        anthropicError: '未配置 ANTHROPIC_API_KEY，无法使用 Claude 模型',
        nvidiaError: '未配置 NVIDIA_API_KEY，无法使用该模型',
      });

      if (useClaude) {
        await handleClaudeChat({ client, model, messages, max_tokens, temperature, res, startedAt });
      } else {
        await handleNvidiaChat({
          createStreamingCompletion,
          model,
          messages,
          temperature,
          top_p,
          max_tokens,
          res,
          startedAt,
        });
      }
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
