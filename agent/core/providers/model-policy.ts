/**
 * Model Policy — 「哪些模型可用于 Agent 决策」的唯一判定点
 *
 * 供应商 listModels() 与「配置改动后重算标记」两条路径都走这里，保证同一个
 * 模型在两条路径上得到一致的结论。判定本身是 resolveAgentCompatible()（纯函数，
 * 在 ai-client.ts），本模块只负责补上「供应商目录怎么说」这一层输入。
 *
 * 关键：applyModelPolicy 是幂等的——没有任何规则表态时会 delete 掉该字段而不是
 * 留下上一次的结论，因此可以对同一个数组反复调用。配置热更新依赖这一点。
 */

import { resolveAgentCompatible } from '../ai-client.ts';
import { getNvidiaCatalogModelMetadata } from './nvidia-catalog.ts';
import { getGeminiCatalogModelMetadata } from './gemini-catalog.ts';
import type { ModelPolicyConfig } from '../config-schema.ts';
import type { ModelInfo } from './types.ts';

/**
 * 供应商本地目录（config/model-catalog/*）对该模型的表态。
 * 非 nvidia/gemini 的 OpenAI 兼容端点没有目录，返回 undefined。
 */
export function catalogAgentCompatible(model: Pick<ModelInfo, 'id' | 'provider'>): boolean | undefined {
  if (model.provider === 'gemini') return getGeminiCatalogModelMetadata(model.id).agentCompatible;
  if (model.provider === 'nvidia') return getNvidiaCatalogModelMetadata(model.id).agentCompatible;
  return undefined;
}

/**
 * 就地重算整张模型列表的 agentCompatible 标记，返回同一个数组引用。
 *
 * 就地修改是有意的：modelConfig 在启动时创建后被路由、agent runner 等多处按引用
 * 持有，保存配置后重算必须让所有持有者立即看到新标记，否则要重启才生效。
 *
 * 当前使用：providers/openai-compat.ts 与 providers/gemini.ts 的 listModels()、
 * routes/agent-config.ts 的 PUT /api/config/models。
 */
export function applyModelPolicy<T extends ModelInfo>(models: T[], policy: ModelPolicyConfig): T[] {
  for (const model of models) {
    const verdict = resolveAgentCompatible(model.id, {
      keywords: policy.nonAgentKeywords,
      overrides: policy.agentCompatible,
      catalogValue: catalogAgentCompatible(model),
    });
    // 无人表态时删字段而非写 undefined：既让 JSON payload 干净，也保证幂等。
    if (verdict === undefined) delete model.agentCompatible;
    else model.agentCompatible = verdict;
  }
  return models;
}
