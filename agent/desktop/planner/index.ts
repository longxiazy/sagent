/**
 * Desktop Planner — 多模型决策调度
 *
 * 每一步先把候选模型交给 model-routing 重排（动态模型路由开启时才生效），
 * 再按策略调度它们，最终产出「这一步执行什么动作」的单个决策。
 *
 * 只有一个候选模型时不走任何策略分支，而是 single-model-path：命中 429 会就地
 * 退避重试至多 SINGLE_MODEL_RATE_LIMIT_RETRY 次（多模型下不重试，直接换模型）。
 *
 * 三种策略的取舍（各自实现见 strategies/）：
 *
 *   race —— UI「竞速」，前端默认
 *     按 batchSize 分批启动，批之间隔 staggerDelaySec；先返回有效结果的胜出，
 *     其余立即 abort。若某批全部失败，跳过延迟直接放下一批（仅 race 有此规则）。
 *     排在前面的模型因此承担主要工作，这也是动态模型路由重排顺序的意义所在。
 *
 *   vote —— UI「汇总」
 *     一次性启动全部活动模型并等待都结束，再由 multi-model.ts 聚合出多数一致的
 *     决策。延迟取决于最慢的模型，每个模型都会跑满，换取更稳的决策质量。
 *     例外：任一模型返回 finish 就立即短路收尾，不等其余。
 *
 *   progressive —— 未接入 UI，仅 API 直调可用
 *     先只跑主模型，超时未返回或提前失败才唤醒其余模型加入竞速。
 *
 * 三种策略共用同一份超时黑名单与限流冷却（见 model-pool），二者都只在本次
 * planner 生命周期内有效：超时的模型被拉黑，命中 429 的进入冷却期。
 * 若某步所有模型都被拉黑，则清空黑名单重试一轮，避免整个 run 卡死。
 */

import { routeAgentModels } from '../../core/model-routing.ts';
import { createModelPool } from './model-pool.ts';
import { createPlanWithTimeout } from './single-model.ts';
import { runSingleModel } from './single-model-path.ts';
import { runRaceStrategy } from './strategies/race.ts';
import { runVoteStrategy } from './strategies/vote.ts';
import { runProgressiveStrategy } from './strategies/progressive.ts';
import { DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_RATE_LIMIT_COOLDOWN_MS } from './shared.ts';

export { DEFAULT_MODEL_TIMEOUT_MS };

export function createDesktopPlanner({
  registry,
  modelConfig,
  blacklistedModels,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  staggerDelayMs = 0,
  batchSize = 1,
  rateLimitCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  autoModelRouting = false,
}: any) {
  const pool = createModelPool({ blacklistedModels, rateLimitCooldownMs });
  const planWithTimeout = createPlanWithTimeout({ registry, modelConfig, modelTimeoutMs });

  return async ({ model, agentModels, strategy = 'race', onEvent, cancelSignal, step, ...context }: any) => {
    const routing = routeAgentModels({
      enabled: autoModelRouting,
      primaryModel: model,
      agentModels,
      modelConfig,
      task: context.task,
      step,
      history: context.history,
    });
    const routedModels = routing.models.length > 0 ? routing.models : [model];
    const primaryModel = routedModels[0];
    const extraModels = routedModels.slice(1);
    const planCtx = { ...context, step };
    // routing 详情仅在开关打开时随事件下发，关闭时前端不展示路由决策。
    const routingPayload = autoModelRouting ? routing : undefined;

    if (extraModels.length === 0) {
      onEvent?.({ type: 'model_plan', stage: 'start', models: [primaryModel], step, routing: routingPayload });
      return runSingleModel({ model: primaryModel, planCtx, planWithTimeout, pool, onEvent, cancelSignal, step });
    }

    const allModels = [primaryModel, ...extraModels];
    const activeModels = pool.selectActiveModels(allModels, step);

    if (activeModels.length === 0) {
      const err = '所有模型均处于限流冷却或禁用状态';
      onEvent?.({ type: 'model_plan', stage: 'failed', step, error: err });
      throw new Error(err);
    }

    // start 事件报 allModels 而非 activeModels：前端需要为每个模型预留卡片。
    // 随后为被跳过的模型补一条事件说明原因，否则它们的卡片会一直停在等待态。
    onEvent?.({ type: 'model_plan', stage: 'start', models: allModels, strategy, step, routing: routingPayload });
    for (const candidate of allModels) {
      if (pool.blacklistedModels.has(candidate)) {
        onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: '模型已被禁用（此前超时）' });
      } else if (pool.isModelCoolingDown(candidate)) {
        onEvent?.({ type: 'model_plan', stage: 'rate_limited', model: candidate, step, error: '模型限流冷却中' });
      }
    }

    const strategyCtx = { activeModels, planCtx, planWithTimeout, pool, onEvent, cancelSignal, step };

    if (strategy === 'vote') return runVoteStrategy(strategyCtx);
    if (strategy === 'progressive') return runProgressiveStrategy(strategyCtx);
    return runRaceStrategy({ ...strategyCtx, staggerDelayMs, batchSize });
  };
}
