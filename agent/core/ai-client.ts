/**
 * AI Client — LLM SDK 客户端构造 + 供应商通用工具函数
 *
 * 职责 / Responsibilities:
 *   1. createClients() — 按 .env 构造 OpenAI(NVIDIA) / Gemini 两套 SDK 客户端
 *   2. deriveProviderName() / isChatCapableModel() — 供各 provider 复用的纯工具函数
 *   3. loadAgentMultiModels() — 读取多模型竞速配置
 *
 * 注意：各供应商的 API 差异（决策、chat、列模型、摘要）已封装到 agent/core/providers/*，
 * 由 createProviderRegistry() 装配。本文件不再包含任何 isClaudeModel 式的二选一逻辑。
 */

import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

export { createModelTools } from './tool-definitions.ts';

// 过滤掉不适合做 agent 决策的模型：向量/重排、视觉/OCR、纯代码补全、内容安全护栏等。
// 这类模型在供应商接口里和对话模型混在一起，全塞进前端下拉会很难选。
const NON_CHAT_MODEL_RE =
  /embed|rerank|retriever|bge-|arctic-embed|nvclip|fuyu|deplot|vila|neva|kosmos|ocr|paddle|-vision|vision-|-vl-|codegemma|starcoder|codellama|-coder|coder-|guard|safety|topic-control/i;

export function isChatCapableModel(id: string) {
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

export function loadAgentMultiModels() {
  const env = process.env.AGENT_MULTI_MODELS;
  if (typeof env === 'string' && env.trim()) {
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export function createClients() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const openai_client = nvidiaKey
    ? new OpenAI({ apiKey: nvidiaKey, baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1', maxRetries: 0 })
    : null;

  const gemini_client = geminiKey
    ? new GoogleGenAI({ apiKey: geminiKey })
    : null;

  return { openai_client, gemini_client };
}
