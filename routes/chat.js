import { Router } from 'express';
import { safeJson } from '../agent/core/utils.js';
import { isClaudeModel } from '../agent/core/ai-client.js';
import { createChatTools } from '../agent/chat/chat-tools.js';
import { executeChatTool } from '../agent/chat/chat-tool-executor.js';
import { buildMetrics, createStreamingCompletionFactory } from '../helpers/streaming.js';
import { log } from '../helpers/logger.js';

const MAX_TOOL_ROUNDS = 5;

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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      if (isClaudeModel(model)) {
        await handleClaudeChat(anthropic_client, { model, messages, max_tokens, temperature }, res, startedAt);
      } else {
        await handleNvidiaChat(openai_client, createStreamingCompletion, { model, messages, temperature, top_p, max_tokens }, res, startedAt);
      }
    } catch (err) {
      log.error('API error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } finally {
      res.end();
    }
  });

  return router;
}

async function handleClaudeChat(client, params, res, startedAt) {
  const { model, messages, max_tokens, temperature } = params;
  const chatTools = createChatTools().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  let currentMessages = [...messages];
  let usage = null;
  let finishReason = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = client.messages.stream({
      model,
      max_tokens,
      temperature,
      messages: currentMessages,
      thinking: { type: 'disabled' },
      tools: chatTools,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
        }
      } else if (event.type === 'message_delta') {
        if (event.delta?.usage) {
          usage = {
            prompt_tokens: event.delta.usage.input_tokens,
            completion_tokens: event.delta.usage.output_tokens,
            total_tokens: event.delta.usage.input_tokens + event.delta.usage.output_tokens,
          };
        }
        if (event.delta?.stop_reason) {
          finishReason = event.delta.stop_reason;
        }
      }
    }

    const message = await stream.finalMessage();
    const toolUseBlocks = message.content.filter(b => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      break;
    }

    // Execute tools and continue
    currentMessages.push(message);
    const toolResults = [];
    for (const block of toolUseBlocks) {
      try {
        const result = await executeChatTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        log.debug(`[Chat Tool] ${block.name} → ${String(result).slice(0, 100)}`);
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `工具执行失败: ${err.message}`, is_error: true });
      }
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  const metrics = buildMetrics(startedAt, usage);
  res.write(`data: ${JSON.stringify({
    done: true,
    finish_reason: finishReason ?? 'end_turn',
    meta: metrics,
  })}\n\n`);
}

async function handleNvidiaChat(client, createStreamingCompletion, params, res, startedAt) {
  const { model, messages, temperature, top_p, max_tokens } = params;
  const chatTools = createChatTools().map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  let currentMessages = [...messages];
  let usage = null;
  let finishReason = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await createStreamingCompletion(
      {
        model,
        messages: currentMessages,
        temperature,
        top_p,
        max_tokens,
        tools: chatTools,
        tool_choice: 'auto',
      },
      { includeUsage: true }
    );

    let textContent = '';
    let toolCalls = [];
    let currentUsage = null;

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      const finish = chunk.choices[0]?.finish_reason;

      if (delta?.content) {
        textContent += delta.content;
        res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }

      if (chunk.usage) {
        currentUsage = chunk.usage;
      }
      if (finish) {
        finishReason = finish;
      }
    }

    usage = currentUsage || usage;
    toolCalls = toolCalls.filter(tc => tc?.id);

    if (toolCalls.length === 0) {
      break;
    }

    // Add assistant message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls,
    });

    // Execute tools
    for (const tc of toolCalls) {
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      try {
        const result = await executeChatTool(tc.function.name, args);
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        log.debug(`[Chat Tool] ${tc.function.name} → ${String(result).slice(0, 100)}`);
      } catch (err) {
        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: `工具执行失败: ${err.message}` });
      }
    }
  }

  const metrics = buildMetrics(startedAt, usage);
  res.write(`data: ${JSON.stringify({
    done: true,
    finish_reason: finishReason ?? 'stop',
    meta: metrics,
  })}\n\n`);
}
