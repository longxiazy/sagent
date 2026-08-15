/**
 * AI Client — LLM SDK 客户端构造 + 供应商通用工具函数
 *
 * 职责 / Responsibilities:
 *   1. createClients() — 按 .env 构造 OpenAI(NVIDIA) / Gemini 两套 SDK 客户端
 *   2. deriveProviderName() / resolveAgentCompatible() — 供各 provider 复用的纯工具函数
 *
 * 注意：各供应商的 API 差异（决策、chat、列模型、摘要）已封装到 agent/core/providers/*，
 * 由 createProviderRegistry() 装配。本文件不再包含任何 isClaudeModel 式的二选一逻辑。
 */

import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

export { createModelTools } from './tool-definitions.ts';

/** 模型 id 是否命中「不适合做 Agent 决策」关键词（子串匹配，大小写不敏感）。 */
export function matchesNonAgentKeyword(id: string, keywords: string[] = []) {
  const target = String(id || '').toLowerCase();
  if (!target) return false;
  return keywords.some(keyword => {
    const needle = String(keyword || '').trim().toLowerCase();
    return !!needle && target.includes(needle);
  });
}

/**
 * 判定模型能否用于 Agent 决策，优先级从高到低：
 *   1. config.json 的 models.agentCompatible[id] —— 用户显式表态，优先级最高
 *   2. 供应商目录元数据（nvidia-overrides.json 等）里的 agentCompatible
 *   3. config.json 的 models.nonAgentKeywords 关键词表（命中即 false）
 *
 * 返回 undefined 表示三条规则都没表态，调用方不写该字段，前端按可用处理。
 * 注意：这里只负责「打标记」，不负责「丢弃」——命中的模型仍会出现在
 * /api/models 全量列表里，只是 Agent 模型选择器会隐藏它们。
 *
 * 当前使用：providers/gemini.ts 与 providers/openai-compat.ts 的 listModels()。
 */
export function resolveAgentCompatible(
  id: string,
  {
    keywords = [],
    overrides = {},
    catalogValue,
  }: {
    keywords?: string[];
    overrides?: Record<string, boolean>;
    catalogValue?: boolean;
  } = {},
): boolean | undefined {
  const key = String(id || '').trim().toLowerCase();
  for (const [overrideId, flag] of Object.entries(overrides)) {
    if (String(overrideId).trim().toLowerCase() === key) return flag;
  }
  if (typeof catalogValue === 'boolean') return catalogValue;
  return matchesNonAgentKeyword(id, keywords) ? false : undefined;
}

/**
 * 从 baseURL 域名推断供应商展示名，用于前端/日志展示当前连的是哪家。
 * 例：api.freemodel.dev → freemodel，integrate.api.nvidia.com → nvidia，留空 → nvidia。
 *
 * 用法：传入 baseURL，解析失败或未传时回退 'nvidia'。
 * 当前使用：server.ts 启动横幅、routes/agent-config.ts 的 provider 展示、providers/openai-compat.ts 的模型注册名。
 */
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

/**
 * 按 .env 构造 OpenAI(NVIDIA) / Gemini 两套 SDK 客户端。
 * 用法：启动时调用一次；缺任一 key 时对应客户端为 null，两者都缺则抛错拒绝启动。
 * 当前使用：server.ts 主进程启动、agent-worker.ts 沙箱 worker 启动、scripts/trace-eval-live.ts 离线评估。
 */
export function createClients() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const openai_client = nvidiaKey
    ? new OpenAI({ apiKey: nvidiaKey, baseURL: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1', maxRetries: 0 })
    : null;

  const gemini_client = geminiKey
    ? new GoogleGenAI({ apiKey: geminiKey })
    : null;

  if (!openai_client && !gemini_client) {
    throw new Error('至少需要配置 NVIDIA_API_KEY / GEMINI_API_KEY 之一');
  }

  return { openai_client, gemini_client };
}
