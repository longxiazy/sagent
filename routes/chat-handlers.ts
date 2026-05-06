import { createChatTools } from '../agent/chat/chat-tools.ts';
import { executeChatTool } from '../agent/chat/chat-tool-executor.ts';
import { buildMetrics } from '../helpers/streaming.ts';
import { log } from '../helpers/logger.ts';
import { buildClaudeUsage, writeSse } from './llm-route-utils.ts';

const MAX_TOOL_ROUNDS = 5;

function buildClaudeChatTools() {
  return createChatTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

function buildOpenAiChatTools() {
  return createChatTools().map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

export async function handleClaudeChat({
  client,
  model,
  messages,
  max_tokens,
  temperature,
  res,
  startedAt,
}: {
  client: any;
  model: string;
  messages: any[];
  max_tokens: number;
  temperature: number;
  res: any;
  startedAt: number;
}) {
  const chatTools = buildClaudeChatTools();
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
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        writeSse(res, { content: event.delta.text });
      } else if (event.type === 'message_delta') {
        usage = buildClaudeUsage(event.delta?.usage) || usage;
        if (event.delta?.stop_reason) {
          finishReason = event.delta.stop_reason;
        }
      }
    }

    const message = await stream.finalMessage();
    const toolUseBlocks = message.content.filter((block: any) => block.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      break;
    }

    currentMessages.push(message);
    const toolResults = [];
    for (const block of toolUseBlocks) {
      try {
        const result = await executeChatTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        log.debug(`[Chat Tool] ${block.name} → ${String(result).slice(0, 100)}`);
      } catch (err: any) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `工具执行失败: ${err.message}`, is_error: true });
      }
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  writeSse(res, {
    done: true,
    finish_reason: finishReason ?? 'end_turn',
    meta: buildMetrics(startedAt, usage),
  });
}

export async function handleNvidiaChat({
  createStreamingCompletion,
  model,
  messages,
  temperature,
  top_p,
  max_tokens,
  res,
  startedAt,
}: {
  createStreamingCompletion: any;
  model: string;
  messages: any[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  res: any;
  startedAt: number;
}) {
  const chatTools = buildOpenAiChatTools();
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
    let toolCalls: any[] = [];
    let currentUsage = null;

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      const finish = chunk.choices[0]?.finish_reason;

      if (delta?.content) {
        textContent += delta.content;
        writeSse(res, { content: delta.content });
      }

      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const idx = toolCall.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: toolCall.id, type: 'function', function: { name: '', arguments: '' } };
          }
          if (toolCall.id) toolCalls[idx].id = toolCall.id;
          if (toolCall.function?.name) toolCalls[idx].function.name += toolCall.function.name;
          if (toolCall.function?.arguments) toolCalls[idx].function.arguments += toolCall.function.arguments;
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
    toolCalls = toolCalls.filter(toolCall => toolCall?.id);
    if (toolCalls.length === 0) {
      break;
    }

    currentMessages.push({
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
      try {
        const result = await executeChatTool(toolCall.function.name, args);
        currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        log.debug(`[Chat Tool] ${toolCall.function.name} → ${String(result).slice(0, 100)}`);
      } catch (err: any) {
        currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: `工具执行失败: ${err.message}` });
      }
    }
  }

  writeSse(res, {
    done: true,
    finish_reason: finishReason ?? 'stop',
    meta: buildMetrics(startedAt, usage),
  });
}
