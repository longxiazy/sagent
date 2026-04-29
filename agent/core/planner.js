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
 * 注意：Claude 模型不走这里，走 ai-client.js 的 claudeAgentPlan()
 */

import { cleanText, safeJson } from './utils.js';
import { createModelResponseParser } from './nvidia-response-parsers.js';
import { logLlmRequest, logLlmResponse } from './llm-logger.js';
import { retryAsync } from '../../helpers/retry.js';
import { log } from '../../helpers/logger.js';

export function createJsonPlanner({
  client,
  temperature = 0.1,
  topP = 1,
  maxTokens = 16000,
  buildMessages,
  normalizeDecision,
  buildParserError,
}) {
  return async ({ model, signal, ...context }) => {
    const messages = buildMessages(context);

    logLlmRequest(model, messages);

    const createOpts = {
      model,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      messages,
    };
    if (signal) createOpts.signal = signal;

    const response = await retryAsync(() => client.chat.completions.create(createOpts));

    logLlmResponse(model, response);

    const parser = createModelResponseParser(model);
    const parsed = parser(response);

    if (!parsed.parseFailed) {
      const result = normalizeDecision(parsed, context);
      return { ...result, usage: parsed.usage, reasoning: parsed.reasoning || null, _hasNarrationAndToolCalls: parsed._hasNarrationAndToolCalls || null };
    }

    // Parse failed — retry with hint
    const content = parsed.rawContent;
    log.warn(`[Planner] 输出无法解析，重试: ${cleanText(content, 120)}`);

    const retryMessages = [...messages, {
      role: 'assistant',
      content,
    }, {
      role: 'user',
      content: '你的上一次输出不是有效的 JSON 动作。请只输出一个 JSON 对象，格式如 {"rationale":"...","action":{"tool":"...","type":"...",...}} 或 {"type":"finish","answer":"..."}。不要输出任何解释文字。',
    }];

    try {
      const retryOpts = {
        model,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        messages: retryMessages,
      };
      if (signal) retryOpts.signal = signal;

      const retryResponse = await retryAsync(() => client.chat.completions.create(retryOpts));
      const retryParsed = parser(retryResponse);

      if (!retryParsed.parseFailed) {
        const result = normalizeDecision(retryParsed, context);
        return { ...result, usage: retryParsed.usage || parsed.usage, reasoning: retryParsed.reasoning || null, _hasNarrationAndToolCalls: parsed._hasNarrationAndToolCalls || null };
      }
    } catch (retryErr) {
      log.warn(`[Planner] 重试也失败: ${retryErr.message}`);
    }

    const msg =
      typeof buildParserError === 'function'
        ? buildParserError(new Error('解析失败'), content, context)
        : '模型动作解析失败';
    throw new Error(`${msg}; 原始输出=${safeJson(cleanText(content, 10240))}`);
  };
}
