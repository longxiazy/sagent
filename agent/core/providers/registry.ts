/**
 * ProviderRegistry — 供应商注册表（可插拔架构的核心）
 *
 * 装配所有已配置的 LLMProvider，对外提供：
 *   - resolve(model, modelConfig): 把模型路由到认领它的 provider（兜底 openai-compat）
 *   - loadModelConfig(): 合并所有 provider 的模型列表（含兜底默认值）
 *   - providers: provider 列表（server resume / banner 等处遍历用）
 *
 * 加第四家供应商：写 createXxxProvider() 实现 LLMProvider 接口，在下方
 * createProviderRegistry() 里 `if (xxx_client) providers.push(...)` 加一行即可。
 * planner / routes / summarizer / server 这些核心调用点无需改动。
 */

import { createAnthropicProvider } from './anthropic.ts';
import { createOpenAICompatProvider } from './openai-compat.ts';
import { createGeminiProvider } from './gemini.ts';
import { deriveProviderName } from '../ai-client.ts';
import { log } from '../../../helpers/logger.ts';
import type { LLMProvider, ModelInfo } from './types.ts';

export interface ProviderRegistry {
  providers: LLMProvider[];
  resolve(model: string, modelConfig?: ModelInfo[] | null): LLMProvider;
  loadModelConfig(): Promise<ModelInfo[]>;
}

export function createProviderRegistry({
  openai_client,
  anthropic_client,
  gemini_client,
}: {
  openai_client?: any;
  anthropic_client?: any;
  gemini_client?: any;
}): ProviderRegistry {
  const providers: LLMProvider[] = [];
  // 顺序即 resolve 的精确匹配优先级；openai-compat 作为兜底放最后。
  if (anthropic_client) providers.push(createAnthropicProvider(anthropic_client));
  if (gemini_client) providers.push(createGeminiProvider(gemini_client));
  if (openai_client) providers.push(createOpenAICompatProvider(openai_client));

  if (providers.length === 0) {
    throw new Error('至少需要配置 NVIDIA_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY 之一');
  }

  function resolve(model: string, modelConfig?: ModelInfo[] | null): LLMProvider {
    const owner = providers.find(p => p.ownsModel(model, modelConfig));
    if (owner) return owner;
    const fallback = providers.find(p => p.name === 'openai-compat');
    if (fallback) return fallback;
    throw new Error(`无可用供应商处理模型 ${model}`);
  }

  async function loadModelConfig(): Promise<ModelInfo[]> {
    const lists = await Promise.all(providers.map(p => p.listModels().catch(() => [] as ModelInfo[])));
    const merged = lists.flat();
    if (merged.length > 0) return merged;

    // 接口拉取全部失败时的兜底，保证服务仍能启动
    log.warn('[Models] 未能从任何供应商接口获取模型，使用兜底默认值');
    const fallbacks: ModelInfo[] = [];
    if (gemini_client) fallbacks.push({ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini' });
    if (anthropic_client) fallbacks.push({ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' });
    if (openai_client) fallbacks.push({ id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', provider: deriveProviderName(process.env.NVIDIA_BASE_URL) });
    return fallbacks;
  }

  return { providers, resolve, loadModelConfig };
}
