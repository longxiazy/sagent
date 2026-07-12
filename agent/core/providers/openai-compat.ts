/**
 * OpenAICompatProvider — OpenAI 兼容供应商（NVIDIA NIM 及任意 OpenAI 兼容端点）
 *
 * 这类供应商不一定支持原生 function calling，agent 决策走「JSON-in-prompt」+
 * nvidia-response-parsers 多策略解析（createJsonPlanner）。completion 走标准
 * OpenAI SDK。是 registry 的兜底 provider（ownsModel 恒 false，由 resolve 兜底）。
 */

import { createJsonPlanner } from '../planner.ts';
import { normalizeDesktopAgentDecision } from '../schemas.ts';
import { buildNvidiaTaskMessages } from '../prompts.ts';
import { deriveProviderName, isChatCapableModel } from '../ai-client.ts';
import {
  buildChatCompletionRequest,
  createChatCompletionWithTemplateFallback,
  isUnsupportedChatTemplateKwargsError,
  isUnsupportedSystemRoleError,
  withoutChatTemplateKwargs,
  withoutSystemRole,
} from '../openai-compatible-request.ts';
import {
  createStreamingCompletionFactory,
  initSse,
  writeSse,
  writeSseDone,
} from '../../../helpers/streaming.ts';
import { retryAsync } from '../../../helpers/retry.ts';
import { log } from '../../../helpers/logger.ts';
import { buildSummaryPrompt } from './summary-prompt.ts';
import { extractModelMetadata } from './model-metadata.ts';
import { getNvidiaCatalogModelMetadata, hasNvidiaCatalogModel } from './nvidia-catalog.ts';
import type {
  LLMProvider,
  ModelInfo,
  AgentPlanOpts,
  AgentPlanResult,
  CompletionOpts,
  CompletionStreamOpts,
  SummarizeOpts,
} from './types.ts';

const REASONING_HEADER = '[Thinking / 推理过程]';

function getReasoningText(source: any, { trim = true } = {}) {
  for (const value of [source?.reasoning_content, source?.reasoning]) {
    if (typeof value === 'string' && value.trim()) {
      return trim ? value.trim() : value;
    }
  }
  return '';
}

function mergeReasoningIntoMessage(message: any) {
  const reasoning = getReasoningText(message);
  if (!reasoning || !message || typeof message !== 'object') return message;
  if (message.content != null && typeof message.content !== 'string') return message;

  const content = typeof message.content === 'string' ? message.content : '';
  if (content.startsWith(REASONING_HEADER)) return message;

  const mergedContent = content.trim()
    ? `${REASONING_HEADER}\n${reasoning}\n\n${content}`
    : `${REASONING_HEADER}\n${reasoning}`;

  return { ...message, content: mergedContent };
}

function preserveReasoningContent(response: any) {
  if (!Array.isArray(response?.choices)) return response;
  return {
    ...response,
    choices: response.choices.map((choice: any) => (
      choice?.message
        ? { ...choice, message: mergeReasoningIntoMessage(choice.message) }
        : choice
    )),
  };
}

type ReasoningStreamState = {
  sawReasoning: boolean;
  startedContent: boolean;
};

function mergeReasoningIntoStreamChunk(chunk: any, states: Map<number, ReasoningStreamState>) {
  if (!Array.isArray(chunk?.choices)) return chunk;

  let changed = false;
  const choices = chunk.choices.map((choice: any, offset: number) => {
    const delta = choice?.delta;
    if (!delta || typeof delta !== 'object') return choice;

    const reasoning = getReasoningText(delta, { trim: false });
    const content = typeof delta.content === 'string' ? delta.content : '';
    const index = typeof choice.index === 'number' ? choice.index : offset;
    const state = states.get(index) || { sawReasoning: false, startedContent: false };
    let nextContent: string | null = null;

    if (reasoning) {
      nextContent = `${state.sawReasoning ? '' : `${REASONING_HEADER}\n`}${reasoning}`;
      state.sawReasoning = true;
      if (content) {
        nextContent += `${state.startedContent ? '' : '\n\n'}${content}`;
        state.startedContent = true;
      }
    } else if (content) {
      if (state.sawReasoning && !state.startedContent) {
        nextContent = `\n\n${content}`;
      }
      state.startedContent = true;
    }

    states.set(index, state);
    if (nextContent === null) return choice;
    changed = true;
    return { ...choice, delta: { ...delta, content: nextContent } };
  });

  return changed ? { ...chunk, choices } : chunk;
}

async function* preserveReasoningContentStream(stream: AsyncIterable<any>) {
  const states = new Map<number, ReasoningStreamState>();
  for await (const chunk of stream) {
    yield mergeReasoningIntoStreamChunk(chunk, states);
  }
}

function isOfficialNvidiaEndpoint(baseURL?: string) {
  if (!baseURL) return true;
  try {
    return new URL(baseURL).hostname.toLowerCase() === 'integrate.api.nvidia.com';
  } catch {
    return false;
  }
}

export function createOpenAICompatProvider(
  client: any,
  { baseURL = process.env.NVIDIA_BASE_URL }: { baseURL?: string } = {},
): LLMProvider {
  const createStreamingCompletion = createStreamingCompletionFactory(client);

  // agent 决策器：JSON-in-prompt + 多策略解析，解析失败带提示重试一次（逻辑在 createJsonPlanner 内）。
  const planner = createJsonPlanner({
    client,
    buildMessages: (ctx: any) => buildNvidiaTaskMessages(ctx),
    buildCompactMessages: (ctx: any) => buildNvidiaTaskMessages({ ...ctx, compact: true }),
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
      const providerName = deriveProviderName(baseURL);
      const useNvidiaCatalogAllowlist = isOfficialNvidiaEndpoint(baseURL);
      // 失败直接抛错，由 registry 聚合原因；全部供应商失败时中止启动。
      const list = await client.models.list();
      for (const m of list.data || []) {
        if (m?.id && isChatCapableModel(m.id)) {
          // NVIDIA 的公开 catalog 比 /v1/models 下线信息更新更及时；两边都存在才展示。
          // 自定义 OpenAI 兼容端点不使用 NVIDIA catalog，避免误删第三方模型。
          if (useNvidiaCatalogAllowlist && !hasNvidiaCatalogModel(m.id)) continue;
          const catalogMetadata = providerName === 'nvidia' ? getNvidiaCatalogModelMetadata(m.id) : {};
          const providerMetadata = extractModelMetadata(m);
          models.push({
            ...catalogMetadata,
            id: m.id,
            label: catalogMetadata.label || m.id,
            provider: providerName,
            ...providerMetadata,
          });
        }
      }
      return models;
    },

    async agentPlan(opts: AgentPlanOpts): Promise<AgentPlanResult> {
      const { model, signal, ...context } = opts;
      return planner({ model, signal, ...context });
    },

    async completionJson(opts: CompletionOpts) {
      const { preserveReasoningContent: shouldPreserveReasoning, signal } = opts;
      const { request, defaultedChatTemplateKwargs } = buildChatCompletionRequest(opts, {
        defaultThinking: shouldPreserveReasoning,
      });
      const response = await createChatCompletionWithTemplateFallback({
        client,
        request,
        reqOpts: signal ? { signal } : undefined,
        defaultedChatTemplateKwargs,
      });
      return shouldPreserveReasoning ? preserveReasoningContent(response) : response;
    },

    async completionStream(opts: CompletionStreamOpts) {
      const { preserveReasoningContent: shouldPreserveReasoning, res } = opts;
      const { request, defaultedChatTemplateKwargs } = buildChatCompletionRequest(opts, {
        defaultThinking: shouldPreserveReasoning,
      });
      let completion;
      let activeRequest = request;
      let templateFallbackUsed = false;
      let systemRoleFallbackUsed = false;
      for (;;) {
        try {
          completion = await createStreamingCompletion(activeRequest, { includeUsage: true });
          break;
        } catch (err) {
          if (
            !templateFallbackUsed
            && defaultedChatTemplateKwargs
            && activeRequest.chat_template_kwargs
            && isUnsupportedChatTemplateKwargsError(err)
          ) {
            templateFallbackUsed = true;
            log.warn('chat_template_kwargs 不受支持，改为关闭 thinking 参数重试:', err.message);
            activeRequest = withoutChatTemplateKwargs(activeRequest);
            continue;
          }
          if (
            !systemRoleFallbackUsed
            && activeRequest.messages?.some?.((message: any) => message?.role === 'system')
            && isUnsupportedSystemRoleError(err)
          ) {
            systemRoleFallbackUsed = true;
            log.warn('system role 不受支持，合并到首条 user 消息后重试:', err.message);
            activeRequest = withoutSystemRole(activeRequest);
            continue;
          }
          throw err;
        }
      }
      initSse(res);
      const stream = shouldPreserveReasoning ? preserveReasoningContentStream(completion) : completion;
      for await (const chunk of stream) {
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
