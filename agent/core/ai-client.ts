/**
 * AI Client — Unified LLM client layer, abstracting NVIDIA (OpenAI-compatible) / Anthropic API differences
 * AI 客户端 — 统一的 LLM 客户端层，屏蔽 NVIDIA / Anthropic 两套 API 差异
 *
 * 职责 / Responsibilities:
 *   1. 管理 OpenAI (NVIDIA) 和 Anthropic (Claude) 两套 SDK 客户端
 *      Manage OpenAI (NVIDIA) and Anthropic (Claude) SDK clients
 *   2. 从供应商接口（/v1/models）加载可用模型列表
 *      Load available models from provider APIs (/v1/models)
 *   3. 提供 Claude 专用的 claudeAgentPlan() — 通过 Anthropic SDK 原生 tool_use 调用
 *      Claude-specific planning via Anthropic SDK native tool_use
 *   4. 提供 summarizeText() — 用于记忆压缩的 LLM 文本摘要
 *      LLM text summarization for memory compaction via summarizeText()
 *
 * 调用场景 / Callers:
 *   - server.js 启动时: createClients() 创建客户端、loadModelConfig() 加载模型列表
 *   - agent/desktop/agent.js singleModelPlan():
 *     Claude 模型走 claudeAgentPlan()，NVIDIA 模型走 planner.js 的 createJsonPlanner()
 *   - routes/agent.js 异步记忆保存: summarizeText() 用于压缩对话记忆
 *
 * TODO / 拆分建议 Refactor suggestions:
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logLlmRequest, logLlmResponse } from './llm-logger.ts';
import { log } from '../../helpers/logger.ts';
import { retryAsync } from '../../helpers/retry.ts';
import { createModelTools, toolToClaudeTool } from './tool-definitions.ts';

export { createModelTools } from './tool-definitions.ts';

// 过滤掉不适合做 agent 决策的模型：向量/重排、视觉/OCR、纯代码补全、内容安全护栏等。
// 这类模型在供应商接口里和对话模型混在一起，全塞进前端下拉会很难选。
const NON_CHAT_MODEL_RE =
  /embed|rerank|retriever|bge-|arctic-embed|nvclip|fuyu|deplot|vila|neva|kosmos|ocr|paddle|-vision|vision-|-vl-|codegemma|starcoder|codellama|-coder|coder-|guard|safety|topic-control/i;

function isChatCapableModel(id: string) {
  return !NON_CHAT_MODEL_RE.test(id);
}

// 从 baseURL 域名推断供应商展示名，用于前端/日志展示当前连的是哪家。
// 例：api.freemodel.dev → freemodel，integrate.api.nvidia.com → nvidia，留空 → nvidia。
export function deriveProviderName(baseURL?: string) {
  if (!baseURL) return 'nvidia';
  try {
    const host = new URL(baseURL).hostname;
    const parts = host.split('.').filter(p => p && p !== 'api' && p !== 'www');
    // 去掉末尾 TLD（com/dev/cn 等），取剩下的最后一段作为主体名
    if (parts.length >= 2) parts.pop();
    return parts[parts.length - 1] || host;
  } catch {
    return 'nvidia';
  }
}

export async function loadModelConfig({ openai_client, anthropic_client }: any = {}) {
  const models = [];

  // OpenAI 兼容供应商：从 /v1/models 拉取
  if (openai_client) {
    const providerName = deriveProviderName(process.env.NVIDIA_BASE_URL);
    try {
      const list = await openai_client.models.list();
      for (const m of list.data || []) {
        if (m?.id && isChatCapableModel(m.id)) {
          models.push({ id: m.id, label: m.id, provider: providerName });
        }
      }
    } catch (err) {
      log.warn(`[Models] 拉取 OpenAI 兼容模型列表失败: ${err?.message || err}`);
    }
  }

  // Anthropic：从 /v1/models 拉取
  if (anthropic_client) {
    try {
      const list = await anthropic_client.models.list();
      for (const m of list.data || []) {
        if (m?.id) models.push({ id: m.id, label: m.display_name || m.id, provider: 'anthropic' });
      }
    } catch (err) {
      log.warn(`[Models] 拉取 Anthropic 模型列表失败: ${err?.message || err}`);
    }
  }

  if (models.length > 0) return models;

  // 接口拉取失败时的兜底，保证服务仍能启动
  log.warn('[Models] 未能从供应商接口获取任何模型，使用兜底默认值');
  if (anthropic_client && !openai_client) {
    return [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' }];
  }
  return [{ id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', provider: deriveProviderName(process.env.NVIDIA_BASE_URL) }];
}

export function loadAgentMultiModels() {
  const env = process.env.AGENT_MULTI_MODELS;
  if (typeof env === 'string' && env.trim()) {
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export function isClaudeModel(model, modelConfig) {
  if (modelConfig) {
    return modelConfig.some(m => m.id === model && m.provider === 'anthropic');
  }
  return model?.startsWith('claude-');
}

export function createClients() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const openai_client = nvidiaKey
    ? new OpenAI({ apiKey: nvidiaKey, baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1', maxRetries: 0 })
    : null;

  const anthropic_client = anthropicKey
    ? new Anthropic({ apiKey: anthropicKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined })
    : null;

  if (!openai_client && !anthropic_client) {
    throw new Error('至少需要配置 NVIDIA_API_KEY 或 ANTHROPIC_API_KEY');
  }

  return { openai_client, anthropic_client };
}

export async function claudeAgentPlan({
  client,
  model,
  maxTokens = 16000,
  temperature: _temperature = 0.1,
  system,
  messages,
  signal,
}) {
  const tools = createModelTools().map(toolToClaudeTool);

  const streamOpts: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    tools,
    system,
    messages,
  };
  if (signal) streamOpts.signal = signal;

  logLlmRequest(model, messages);

  const stream = await retryAsync(() => client.messages.stream(streamOpts));

  for await (const _event of stream) {
    // Stream events — we use the final message for complete tool_use data
  }

  const message = await stream.finalMessage();

  logLlmResponse(model, { usage: message.usage, choices: [{ message }] });

  // Extract tool_use block from the complete message
  const toolBlock = message.content.find(b => b.type === 'tool_use');
  if (toolBlock) {
    return {
      content: { name: toolBlock.name, input: toolBlock.input },
      stop_reason: message.stop_reason,
      usage: message.usage,
    };
  }

  // Fallback: try to find text block and parse it as JSON (for finish action)
  const textBlock = message.content.find(b => b.type === 'text');
  if (textBlock?.text) {
    try {
      return { content: JSON.parse(textBlock.text), stop_reason: message.stop_reason, usage: message.usage };
    } catch {
      // not JSON
    }
  }

  throw new Error(`Claude 未返回有效工具调用，停止原因: ${message.stop_reason}`);
}
