/**
 * ProviderRegistry — 供应商注册表（可插拔架构的核心）
 *
 * 装配所有已配置的 LLMProvider，对外提供：
 *   - resolve(model, modelConfig): 把模型路由到认领它的 provider（兜底 openai-compat）
 *   - fetchModels(): 向所有 provider 要一遍模型列表，原样返回结果与失败原因（不做取舍）
 *   - loadModelConfig(): 启动用。在 fetchModels 之上取舍：全部获取失败则抛错中止启动
 *   - providers: provider 列表（server resume / banner 等处遍历用）
 *
 * 加第四家供应商：写 createXxxProvider() 实现 LLMProvider 接口，在下方
 * createProviderRegistry() 里 `if (xxx_client) providers.push(...)` 加一行即可。
 * planner / routes / server 这些核心调用点无需改动。
 */

import { createOpenAICompatProvider } from './openai-compat.ts';
import { createGeminiProvider } from './gemini.ts';
import { log } from '../../../helpers/logger.ts';
import type { LLMProvider, ModelInfo } from './types.ts';

export interface ModelFetchResult {
  /** 所有成功供应商的模型合并而成；有供应商失败时它只是「活着那部分」。 */
  models: ModelInfo[];
  /** 每条形如 `${provider}: ${原因}`。空数组 = 所有供应商都成功。 */
  failures: string[];
}

export interface ProviderRegistry {
  providers: LLMProvider[];
  resolve(model: string, modelConfig?: ModelInfo[] | null): LLMProvider;
  fetchModels(): Promise<ModelFetchResult>;
  loadModelConfig(): Promise<ModelInfo[]>;
}

export function createProviderRegistry({
  openai_client,
  gemini_client,
}: {
  openai_client?: any;
  gemini_client?: any;
}): ProviderRegistry {
  const providers: LLMProvider[] = [];
  // 顺序即 resolve 的精确匹配优先级；openai-compat 作为兜底放最后。
  if (gemini_client) providers.push(createGeminiProvider(gemini_client));
  if (openai_client) providers.push(createOpenAICompatProvider(openai_client));

  if (providers.length === 0) {
    throw new Error('至少需要配置 NVIDIA_API_KEY / GEMINI_API_KEY 之一');
  }

  function resolve(model: string, modelConfig?: ModelInfo[] | null): LLMProvider {
    const owner = providers.find(p => p.ownsModel(model, modelConfig));
    if (owner) return owner;
    const fallback = providers.find(p => p.name === 'openai-compat');
    if (fallback) return fallback;
    throw new Error(`无可用供应商处理模型 ${model}`);
  }

  // 只负责「问一遍所有供应商」，不判断成败也不抛错——启动要的是「有一家就能跑」，
  // 运行期手动刷新要的是「有一家失败就整体放弃」，取舍留给各自的调用方。
  async function fetchModels(): Promise<ModelFetchResult> {
    const results = await Promise.allSettled(providers.map(p => p.listModels()));
    const models: ModelInfo[] = [];
    const failures: string[] = [];
    results.forEach((r, i) => {
      const name = providers[i].name;
      if (r.status === 'fulfilled') {
        if (r.value.length > 0) models.push(...r.value);
        else failures.push(`${name}: 接口可达但返回 0 个可用模型`);
      } else {
        failures.push(`${name}: ${r.reason?.message || String(r.reason)}`);
      }
    });
    return { models, failures };
  }

  async function loadModelConfig(): Promise<ModelInfo[]> {
    const { models, failures } = await fetchModels();

    if (models.length > 0) {
      // 至少一家成功即可启动；失败的供应商记录原因便于排查，但不阻塞。
      if (failures.length > 0) {
        log.warn(`[Models] 部分供应商获取模型失败（已忽略）:\n  - ${failures.join('\n  - ')}`);
      }
      return models;
    }

    // 全部失败：不再兜底默认模型，直接抛错让启动失败并给出原因。
    throw new Error(
      `未能从任何供应商获取模型列表，启动中止。请检查 API Key / 网络 / BASE_URL。各供应商失败原因:\n  - ${failures.join('\n  - ')}`,
    );
  }

  return { providers, resolve, fetchModels, loadModelConfig };
}
