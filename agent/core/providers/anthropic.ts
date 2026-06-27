/**
 * AnthropicProvider — Claude（Anthropic SDK 原生 tool_use）
 *
 * 封装 Claude 的全部 API 差异：原生 tool_use 决策、messages.stream 聊天、
 * /v1/models 列表、记忆摘要。由 createProviderRegistry() 装配。
 */

import {
  buildClaudeTaskMessages,
  buildDesktopAgentSystemPrompt,
} from '../prompts.ts';
import { createModelTools, toolToClaudeTool } from '../tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../schemas.ts';
import { logLlmRequest, logLlmResponse } from '../llm-logger.ts';
import { initSse, writeSse, writeSseDone } from '../../../helpers/streaming.ts';
import { retryAsync } from '../../../helpers/retry.ts';
import type {
  LLMProvider,
  ModelInfo,
  AgentPlanOpts,
  AgentPlanResult,
  CompletionOpts,
  CompletionStreamOpts,
  SummarizeOpts,
} from './types.ts';

function buildClaudeUsage(usage: any) {
  if (!usage) return null;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
  };
}

// 把 Claude 的 tool_use（{ name, input }）转成标准化的 { rationale, action }。
function toolUseToNormalizedDecision(toolUse: any) {
  const { name, input } = toolUse;
  if (!name || !input) {
    throw new Error(`无效的工具调用: ${JSON.stringify(toolUse)}`);
  }
  const action = { type: name, ...input };
  return normalizeDesktopAgentDecision({ action });
}

function buildChatCompletionResponse({ model, text, finishReason, usage }: { model: string; text: string; finishReason: string; usage: any }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    usage,
  };
}

function buildChatChunk({ model, content, finishReason }: { model: string; content?: string; finishReason: string | null }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

export function createAnthropicProvider(client: any): LLMProvider {
  return {
    name: 'anthropic',
    client,

    ownsModel(model: string, modelConfig?: ModelInfo[] | null) {
      if (modelConfig) {
        return modelConfig.some(m => m.id === model && m.provider === 'anthropic');
      }
      return typeof model === 'string' && model.startsWith('claude-');
    },

    async listModels() {
      const models: ModelInfo[] = [];
      // 失败直接抛错，由 registry 聚合原因；全部供应商失败时中止启动。
      const list = await client.models.list();
      for (const m of list.data || []) {
        if (m?.id) models.push({ id: m.id, label: m.display_name || m.id, provider: 'anthropic' });
      }
      return models;
    },

    async agentPlan(opts: AgentPlanOpts): Promise<AgentPlanResult> {
      const { model, signal, systemPrompt } = opts;
      const system = buildDesktopAgentSystemPrompt(systemPrompt);
      const messages = buildClaudeTaskMessages(opts as any);
      const tools = createModelTools().map(toolToClaudeTool);

      const streamOpts: Record<string, any> = {
        model,
        max_tokens: 16000,
        tools,
        system,
        messages,
      };
      if (signal) streamOpts.signal = signal;

      logLlmRequest(model, messages);
      const stream = await retryAsync(() => client.messages.stream(streamOpts), undefined, undefined, { retryRateLimit: false });
      for await (const _event of stream) {
        // 仅用最终消息拿完整 tool_use
      }
      const message = await stream.finalMessage();
      logLlmResponse(model, { usage: message.usage, choices: [{ message }] });

      const toolBlock = message.content.find((b: any) => b.type === 'tool_use');
      const usage = message.usage
        ? { prompt_tokens: message.usage.input_tokens || 0, completion_tokens: message.usage.output_tokens || 0 }
        : null;

      if (toolBlock) {
        const decision = toolUseToNormalizedDecision({ name: toolBlock.name, input: toolBlock.input });
        return { ...decision, usage, reasoning: null };
      }

      // fallback：尝试把 text 当作 JSON finish 动作
      const textBlock = message.content.find((b: any) => b.type === 'text');
      if (textBlock?.text) {
        try {
          const decision = normalizeDesktopAgentDecision(JSON.parse(textBlock.text));
          return { ...decision, usage, reasoning: null };
        } catch {
          // not JSON
        }
      }
      throw new Error(`Claude 未返回有效工具调用，停止原因: ${message.stop_reason}`);
    },

    async completionJson(opts: CompletionOpts) {
      const { model, messages, max_tokens, temperature } = opts;
      const response = await client.messages.create({ model, max_tokens, temperature, messages });
      const text = response.content.find((block: any) => block.type === 'text')?.text || '';
      const usage = buildClaudeUsage(response.usage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      return buildChatCompletionResponse({ model, text, finishReason: response.stop_reason || 'stop', usage });
    },

    async completionStream(opts: CompletionStreamOpts) {
      const { model, messages, max_tokens, temperature, res } = opts;
      initSse(res);
      const stream = client.messages.stream({ model, max_tokens, temperature, messages });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          writeSse(res, buildChatChunk({ model, content: event.delta.text, finishReason: null }));
        } else if (event.type === 'message_delta') {
          writeSse(res, buildChatChunk({ model, finishReason: event.delta?.stop_reason || 'stop' }));
        }
      }
      writeSseDone(res);
      res.end();
    },

    async summarize(opts: SummarizeOpts) {
      const { text, model } = opts;
      const prompt = buildSummaryPrompt(text);
      const resp = await retryAsync(() => client.messages.create({
        model,
        max_tokens: 800,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }));
      return resp.content.find((block: any) => block.type === 'text')?.text || text.slice(0, 300);
    },
  };
}

// 摘要 prompt 与 openai-compat 复用同一份，导出供 registry 之外的 provider 共享。
export function buildSummaryPrompt(text: string) {
  return `请用简洁的中文提炼以下 Agent 任务记录的关键信息。要求：
1. 相同或相似主题的任务合并为一条，不要重复
2. 每个任务一行，格式：任务→结果要点
3. 保留重要的事实、数据和结论
4. 去除冗余细节

${text}`;
}
