/**
 * Planner — NVIDIA (OpenAI-compatible) 模型的决策层
 *
 * 负责：调用 LLM API → 用 nvidia-response-parsers 工厂解析响应 → 返回标准化的 { rationale, action }
 * 如果解析失败，会带提示重试一次。
 *
 * 调用场景：
 *   - agent/desktop/agent.js 的 singleModelPlan() 中通过 createJsonPlanner() 创建
 *   - 每次 runtime 循环的 decide 步骤调用 planner({ model, task, step, history, observation })
 *
 */

import { cleanText, safeJson } from './utils.ts';
import { createModelResponseParser } from './nvidia-response-parsers.ts';
import { logLlmError, logLlmRequest, logLlmResponse } from './llm-logger.ts';
import { log } from '../../helpers/logger.ts';
import { estimatePayloadTokens, inferContextWindow } from './context-estimate.ts';
import {
  buildChatCompletionRequest,
  createChatCompletionWithTemplateFallback,
} from './openai-compatible-request.ts';

// 每一步只需产出一个结构化动作；过大的输出预算会放大推理延迟和供应商超时风险。
const DEFAULT_AGENT_MAX_TOKENS = 4_096;
const MIN_AGENT_MAX_TOKENS = 1;
const MIN_USEFUL_AGENT_MAX_TOKENS = 128;
const CONTEXT_RETRY_RESERVE_TOKENS = 128;

function findModelInfo(model: string, modelConfig: any[] | null | undefined) {
  if (!Array.isArray(modelConfig)) return null;
  return modelConfig.find(item => item?.id === model) || null;
}

function firstPositiveNumber(values: any[]) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function resolveAgentMaxTokens({
  model,
  modelConfig,
  requestedMaxTokens = DEFAULT_AGENT_MAX_TOKENS,
  promptPayload,
  contextWindowOverride,
}: {
  model: string;
  modelConfig?: any[] | null;
  requestedMaxTokens?: number;
  promptPayload: any;
  contextWindowOverride?: number | null;
}) {
  const modelInfo = findModelInfo(model, modelConfig);
  const contextWindow = Number.isFinite(Number(contextWindowOverride)) && Number(contextWindowOverride) > 0
    ? Number(contextWindowOverride)
    : inferContextWindow(model, modelInfo);
  const outputLimit = firstPositiveNumber([
    modelInfo?.maxOutputTokens,
    modelInfo?.outputTokenLimit,
    modelInfo?.max_completion_tokens,
    modelInfo?.output_token_limit,
  ]);
  const promptTokens = estimatePayloadTokens(promptPayload);
  const promptEstimate = Math.ceil(promptTokens * 1.25);
  const contextReserve = Math.max(128, Math.ceil(contextWindow * 0.05));
  const contextAvailable = Math.max(
    MIN_AGENT_MAX_TOKENS,
    contextWindow - promptEstimate - contextReserve,
  );

  return Math.max(
    MIN_AGENT_MAX_TOKENS,
    Math.min(requestedMaxTokens, outputLimit || requestedMaxTokens, contextAvailable),
  );
}

export function maxTokensFromContextLengthError(err: any) {
  return contextLengthDetailsFromError(err)?.retryMaxTokens ?? null;
}

function contextLengthDetailsFromError(err: any) {
  const message = String(err?.message || err?.error?.message || '');
  const match = message.match(/maximum context length is\s+(\d+)\s+tokens[\s\S]*?\((\d+)\s+in the messages,\s*(\d+)\s+in the completion\)/i);
  if (!match) return null;

  const contextWindow = Number(match[1]);
  const promptTokens = Number(match[2]);
  const completionTokens = Number(match[3]);
  if (![contextWindow, promptTokens, completionTokens].every(n => Number.isFinite(n) && n > 0)) {
    return null;
  }

  const retryMaxTokens = Math.max(
    MIN_AGENT_MAX_TOKENS,
    contextWindow - promptTokens - CONTEXT_RETRY_RESERVE_TOKENS,
  );

  return {
    contextWindow,
    promptTokens,
    completionTokens,
    retryMaxTokens: retryMaxTokens < completionTokens ? retryMaxTokens : null,
  };
}

export function createJsonPlanner({
  client,
  temperature = 0.1,
  topP = 1,
  maxTokens = DEFAULT_AGENT_MAX_TOKENS,
  buildMessages,
  buildCompactMessages = null,
  normalizeDecision,
  buildParserError = null,
}) {
  return async ({ model, signal = null, ...context }) => {
    let messages = buildMessages(context);
    let requestMaxTokens = resolveAgentMaxTokens({
      model,
      modelConfig: context.modelConfig,
      requestedMaxTokens: maxTokens,
      promptPayload: messages,
    });
    let usedCompactPrompt = false;

    if (requestMaxTokens < MIN_USEFUL_AGENT_MAX_TOKENS && typeof buildCompactMessages === 'function') {
      const compactMessages = buildCompactMessages(context);
      const compactMaxTokens = resolveAgentMaxTokens({
        model,
        modelConfig: context.modelConfig,
        requestedMaxTokens: maxTokens,
        promptPayload: compactMessages,
      });
      if (compactMaxTokens > requestMaxTokens) {
        messages = compactMessages;
        requestMaxTokens = compactMaxTokens;
        usedCompactPrompt = true;
        log.warn(`[Planner] 模型上下文偏小，使用 compact prompt: max_tokens ${requestMaxTokens}`);
      }
    }

    logLlmRequest(model, messages);

    const builtRequest = buildChatCompletionRequest({
      model,
      temperature,
      top_p: topP,
      max_tokens: requestMaxTokens,
      messages,
    }, { defaultThinking: true });
    const createOpts = builtRequest.request;
    let defaultedChatTemplateKwargs = builtRequest.defaultedChatTemplateKwargs;
    const reqOpts = signal ? { signal } : undefined;
    let responseMaxTokens = requestMaxTokens;
    const retryContext = {
      operation: 'desktop.plan',
      phase: 'initial',
      provider: 'openai-compatible',
      model,
      step: context.step,
      message_count: messages.length,
      max_tokens: requestMaxTokens,
      compact_prompt: usedCompactPrompt || undefined,
    };

    let response;
    try {
      response = await createChatCompletionWithTemplateFallback({
        client,
        request: createOpts,
        reqOpts,
        retryContext,
        retryOptions: { retryRateLimit: false },
        defaultedChatTemplateKwargs,
      });
    } catch (err) {
      const contextLengthDetails = contextLengthDetailsFromError(err);
      const retryMaxTokens = contextLengthDetails?.retryMaxTokens;
      if (!retryMaxTokens || retryMaxTokens >= createOpts.max_tokens) {
        logLlmError(model, err, retryContext);
        throw err;
      }

      if (retryMaxTokens < MIN_USEFUL_AGENT_MAX_TOKENS && typeof buildCompactMessages === 'function' && !usedCompactPrompt) {
        const compactMessages = buildCompactMessages(context);
        const compactMaxTokens = resolveAgentMaxTokens({
          model,
          modelConfig: context.modelConfig,
          requestedMaxTokens: maxTokens,
          promptPayload: compactMessages,
          contextWindowOverride: contextLengthDetails.contextWindow,
        });
        if (compactMaxTokens >= MIN_USEFUL_AGENT_MAX_TOKENS) {
          log.warn(`[Planner] 模型上下文不足，切换 compact prompt 后重试: ${createOpts.max_tokens} -> ${compactMaxTokens}`);
          messages = compactMessages;
          usedCompactPrompt = true;
          const { request: compactOpts, defaultedChatTemplateKwargs: compactDefaultedChatTemplateKwargs } = buildChatCompletionRequest({
            model,
            temperature,
            top_p: topP,
            max_tokens: compactMaxTokens,
            messages,
          }, { defaultThinking: true });
          try {
            response = await createChatCompletionWithTemplateFallback({
              client,
              request: compactOpts,
              reqOpts,
              retryContext: { ...retryContext, phase: 'initial-compact-retry', max_tokens: compactMaxTokens, compact_prompt: true },
              retryOptions: { retryRateLimit: false },
              defaultedChatTemplateKwargs: compactDefaultedChatTemplateKwargs,
            });
            responseMaxTokens = compactMaxTokens;
            createOpts.chat_template_kwargs = compactOpts.chat_template_kwargs;
            defaultedChatTemplateKwargs = compactDefaultedChatTemplateKwargs;
          } catch (compactErr) {
            logLlmError(model, compactErr, { ...retryContext, phase: 'initial-compact-retry', max_tokens: compactMaxTokens, compact_prompt: true });
            throw compactErr;
          }
        }
      }

      if (response) {
        // compact retry succeeded
      } else {
        if (retryMaxTokens < MIN_USEFUL_AGENT_MAX_TOKENS) {
          const tooSmallErr = new Error(
            `模型上下文太小，无法承载 Desktop Agent 提示。请换用上下文更大的模型，或减少历史对话后重试。（context=${contextLengthDetails.contextWindow}, prompt=${contextLengthDetails.promptTokens}, available=${retryMaxTokens}）`
          );
          (tooSmallErr as any).status = 400;
          logLlmError(model, tooSmallErr, { ...retryContext, phase: 'context-too-small', max_tokens: retryMaxTokens });
          throw tooSmallErr;
        }

        log.warn(`[Planner] 模型上下文不足，降低 max_tokens 后重试: ${createOpts.max_tokens} -> ${retryMaxTokens}`);
        try {
          response = await createChatCompletionWithTemplateFallback({
            client,
            request: { ...createOpts, max_tokens: retryMaxTokens },
            reqOpts,
            retryContext: { ...retryContext, phase: 'initial-context-retry', max_tokens: retryMaxTokens },
            retryOptions: { retryRateLimit: false },
            defaultedChatTemplateKwargs,
          });
          responseMaxTokens = retryMaxTokens;
        } catch (retryErr) {
          logLlmError(model, retryErr, { ...retryContext, phase: 'initial-context-retry', max_tokens: retryMaxTokens });
          throw retryErr;
        }
      }
    }

    logLlmResponse(model, response);

    const parser = createModelResponseParser(model);
    const parsed = parser(response);

    if (!parsed.parseFailed) {
      try {
        const result = normalizeDecision(parsed, context);
        return { ...result, usage: parsed.usage, reasoning: parsed.reasoning || null };
      } catch (normalizeErr: any) {
        log.warn(`[Planner] 动作校验失败，重试: ${normalizeErr.message}`);
        const retryResult = await retryWithHint({
          client,
          model,
          parser,
          messages,
          content: parsed.rawContent,
          usage: parsed.usage,
          context,
          createOpts: { temperature, top_p: topP, max_tokens: responseMaxTokens, chat_template_kwargs: createOpts.chat_template_kwargs },
          defaultedChatTemplateKwargs,
          reqOpts,
          normalizeDecision,
          hint: `你的上一次 JSON 动作无法执行：${normalizeErr.message}。请只使用系统提示中列出的工具和动作名，不要编造工具/动作名。输出一个新的有效 JSON 动作。`,
        });
        if (retryResult) return retryResult;
        throw normalizeErr;
      }
    }

    // Parse failed — retry with hint
    const content = parsed.rawContent;
    log.warn(`[Planner] 输出无法解析，重试: ${cleanText(content, 120)}`);

    const retryResult = await retryWithHint({
      client,
      model,
      parser,
      messages,
      content,
      usage: parsed.usage,
      context,
      createOpts: { temperature, top_p: topP, max_tokens: responseMaxTokens, chat_template_kwargs: createOpts.chat_template_kwargs },
      defaultedChatTemplateKwargs,
      reqOpts,
      normalizeDecision,
      hint: '你的上一次输出不是有效的 JSON 动作。请只输出一个 JSON 对象，格式如 {"rationale":"...","action":{"tool":"...","type":"...",...}} 或 {"type":"finish","answer":"..."}。不要输出任何解释文字。',
    });
    if (retryResult) return retryResult;

    const msg =
      typeof buildParserError === 'function'
        ? buildParserError(new Error('解析失败'), content, context)
        : '模型动作解析失败';
    throw new Error(`${msg}; 原始输出=${safeJson(cleanText(content, 10240))}`);
  };
}

async function retryWithHint({
  client,
  model,
  parser,
  messages,
  content,
  usage,
  context,
  createOpts,
  defaultedChatTemplateKwargs,
  reqOpts,
  normalizeDecision,
  hint,
}) {
  const retryMessages = [...messages, {
    role: 'assistant',
    content,
  }, {
    role: 'user',
    content: hint,
  }];

  try {
    const retryOpts = {
      model,
      ...createOpts,
      messages: retryMessages,
    };

    const retryContext = {
      operation: 'desktop.plan',
      phase: 'parser-retry',
      provider: 'openai-compatible',
      model,
      step: context.step,
      message_count: retryMessages.length,
      max_tokens: createOpts.max_tokens,
    };
    const retryResponse = await createChatCompletionWithTemplateFallback({
      client,
      request: retryOpts,
      reqOpts,
      retryContext,
      retryOptions: { retryRateLimit: false },
      defaultedChatTemplateKwargs,
    });
    const retryParsed = parser(retryResponse);

    if (!retryParsed.parseFailed) {
      const result = normalizeDecision(retryParsed, context);
      return { ...result, usage: retryParsed.usage || usage, reasoning: retryParsed.reasoning || null };
    }
  } catch (retryErr) {
    logLlmError(model, retryErr, {
      operation: 'desktop.plan',
      phase: 'parser-retry',
      provider: 'openai-compatible',
      model,
      step: context.step,
    });
    log.warn(`[Planner] 重试也失败: ${retryErr.message}`);
  }

  return null;
}
