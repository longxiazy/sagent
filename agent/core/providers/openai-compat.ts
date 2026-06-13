/**
 * OpenAICompatProvider — OpenAI 兼容供应商（NVIDIA NIM 及任意 OpenAI 兼容端点）
 *
 * 这类供应商不一定支持原生 function calling，agent 决策走「JSON-in-prompt」+
 * nvidia-response-parsers 多策略解析（createJsonPlanner）。chat/completion 走标准
 * OpenAI SDK。是 registry 的兜底 provider（ownsModel 恒 false，由 resolve 兜底）。
 */

import { createJsonPlanner } from '../planner.ts';
import { normalizeDesktopAgentDecision } from '../schemas.ts';
import { buildNvidiaTaskMessages } from '../prompts.ts';
import { deriveProviderName, isChatCapableModel } from '../ai-client.ts';
import { createChatTools } from '../../chat/chat-tools.ts';
import { executeChatTool } from '../../chat/chat-tool-executor.ts';
import {
  buildMetrics,
  createStreamingCompletionFactory,
  initSse,
  writeSse,
  writeSseDone,
} from '../../../helpers/streaming.ts';
import { retryAsync } from '../../../helpers/retry.ts';
import { log } from '../../../helpers/logger.ts';
import { buildSummaryPrompt } from './anthropic.ts';
import type {
  LLMProvider,
  ModelInfo,
  AgentPlanOpts,
  AgentPlanResult,
  ChatStreamOpts,
  CompletionOpts,
  CompletionStreamOpts,
  SummarizeOpts,
} from './types.ts';

const MAX_TOOL_ROUNDS = 5;

function buildOpenAiChatTools() {
  return createChatTools().map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

export function createOpenAICompatProvider(client: any): LLMProvider {
  const createStreamingCompletion = createStreamingCompletionFactory(client);

  // agent 决策器：JSON-in-prompt + 多策略解析，解析失败带提示重试一次（逻辑在 createJsonPlanner 内）。
  const planner = createJsonPlanner({
    client,
    buildMessages: (ctx: any) => buildNvidiaTaskMessages(ctx),
    normalizeDecision: normalizeDesktopAgentDecision,
    buildParserError(err: Error) {
      return `模型动作解析失败: ${err.message}`;
    },
  });

  return {
    name: 'openai-compat',
    client,

    // 兜底 provider，不主动认领模型——registry.resolve 在没有其它 provider 认领时回退到它。
    ownsModel() {
      return false;
    },

    async listModels() {
      const models: ModelInfo[] = [];
      const providerName = deriveProviderName(process.env.NVIDIA_BASE_URL);
      try {
        const list = await client.models.list();
        for (const m of list.data || []) {
          if (m?.id && isChatCapableModel(m.id)) {
            models.push({ id: m.id, label: m.id, provider: providerName });
          }
        }
      } catch (err: any) {
        log.warn(`[Models] 拉取 OpenAI 兼容模型列表失败: ${err?.message || err}`);
      }
      return models;
    },

    async agentPlan(opts: AgentPlanOpts): Promise<AgentPlanResult> {
      const { model, signal, ...context } = opts;
      return planner({ model, signal, ...context });
    },

    async chatStream(opts: ChatStreamOpts) {
      const { model, messages, temperature, top_p, max_tokens, res, startedAt } = opts;
      const chatTools = buildOpenAiChatTools();
      let currentMessages = [...messages];
      let usage = null;
      let finishReason = null;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const completion = await createStreamingCompletion(
          { model, messages: currentMessages, temperature, top_p, max_tokens, tools: chatTools, tool_choice: 'auto' },
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
          if (chunk.usage) currentUsage = chunk.usage;
          if (finish) finishReason = finish;
        }

        usage = currentUsage || usage;
        toolCalls = toolCalls.filter(toolCall => toolCall?.id);
        if (toolCalls.length === 0) break;

        currentMessages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });

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
    },

    async completionJson(opts: CompletionOpts) {
      const { model, messages, temperature, top_p, max_tokens } = opts;
      return client.chat.completions.create({ model, messages, temperature, top_p, max_tokens });
    },

    async completionStream(opts: CompletionStreamOpts) {
      const { model, messages, temperature, top_p, max_tokens, res } = opts;
      const completion = await createStreamingCompletion(
        { model, messages, temperature, top_p, max_tokens },
        { includeUsage: true }
      );
      initSse(res);
      for await (const chunk of completion) {
        writeSse(res, chunk);
      }
      writeSseDone(res);
      res.end();
    },

    async summarize(opts: SummarizeOpts) {
      const { text, model } = opts;
      const prompt = buildSummaryPrompt(text);
      const resp = await retryAsync(() => client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
      }));
      return resp?.choices?.[0]?.message?.content || text.slice(0, 300);
    },
  };
}
