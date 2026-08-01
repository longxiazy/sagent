/**
 * 模型池：维护本次 planner 生命周期内的模型可用性，并筛出每一步的候选集。
 *
 * 两种不可用状态的语义不同：
 *   - 黑名单（超时）：模型可能卡住，本次 run 内不再调度，无自动恢复
 *   - 冷却（429）：只是暂时限流，到期自动恢复
 * 因此「全部不可用」时只重置黑名单——冷却应当等它自然过期，硬闯只会再撞一次限流。
 */

import { log } from '../../../helpers/logger.ts';
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from './shared.ts';

export function createModelPool({
  blacklistedModels,
  rateLimitCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
}: {
  blacklistedModels: Set<string>;
  rateLimitCooldownMs?: number;
}) {
  const modelCooldownUntil = new Map<string, number>();

  function isModelCoolingDown(model: string) {
    const until = modelCooldownUntil.get(model) || 0;
    // 顺手清理过期项，省掉单独的定时清理。
    if (until <= Date.now()) {
      modelCooldownUntil.delete(model);
      return false;
    }
    return true;
  }

  function markModelRateLimited(model: string, err: any, onEvent?: any, step?: number) {
    modelCooldownUntil.set(model, Date.now() + rateLimitCooldownMs);
    log.warn(`[MultiModel] ${model} 触发限流，暂停 ${Math.ceil(rateLimitCooldownMs / 1000)}s: ${err.message}`);
    onEvent?.({
      type: 'model_plan',
      stage: 'rate_limited',
      model,
      step,
      cooldown_ms: rateLimitCooldownMs,
      error: String(err.message || err).slice(0, 160),
    });
  }

  /**
   * 筛出本步可用的模型。全被拉黑时清空黑名单重来一轮：
   * 拉黑源于超时这类临时故障，不该让整个 run 就此卡死。
   * 返回空数组表示确实无模型可用（例如都在限流冷却中），由调用方报错。
   */
  function selectActiveModels(allModels: string[], step?: number) {
    let activeModels = allModels.filter(model => !blacklistedModels.has(model) && !isModelCoolingDown(model));

    log.info(
      `[MultiModel] step=${step} allModels=[${allModels}] blacklisted=[${[...blacklistedModels]}] ` +
      `cooling=[${[...modelCooldownUntil.keys()]}] activeModels=[${activeModels}]`
    );

    if (activeModels.length === 0 && allModels.every(model => blacklistedModels.has(model))) {
      log.warn('[MultiModel] 所有模型均已被禁用，重置黑名单重试');
      blacklistedModels.clear();
      activeModels = [...allModels];
    }

    return activeModels;
  }

  return {
    blacklistedModels,
    isModelCoolingDown,
    markModelRateLimited,
    selectActiveModels,
  };
}

export type ModelPoolInstance = ReturnType<typeof createModelPool>;
