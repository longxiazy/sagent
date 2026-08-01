/**
 * 单模型路径：候选集只有一个模型时走这里，不进入任何策略分支。
 *
 * 与多模型的关键差异是限流处理——没有备胎可切，只能就地指数退避重试；
 * 多模型下命中 429 直接换模型，不重试。
 * 超时则仍视为致命：拉黑并抛出，避免一个卡住的模型拖垮后续每一步。
 */

import { log } from '../../../helpers/logger.ts';
import {
  SINGLE_MODEL_RATE_LIMIT_RETRY,
  SINGLE_MODEL_RETRY_BASE_BACKOFF_MS,
  isRateLimitError,
  isTimeoutError,
  planEventPayload,
  sleepWithCancel,
} from './shared.ts';
import type { PlanWithTimeout } from './single-model.ts';
import type { ModelPoolInstance } from './model-pool.ts';

export async function runSingleModel({
  model,
  planCtx,
  planWithTimeout,
  pool,
  onEvent,
  cancelSignal,
  step,
}: {
  model: string;
  planCtx: any;
  planWithTimeout: PlanWithTimeout;
  pool: ModelPoolInstance;
  onEvent?: (payload: any) => void;
  cancelSignal?: AbortSignal;
  step?: number;
}) {
  // 唯一的模型若已被拉黑则无路可走，直接失败，不像多模型那样还能筛选。
  if (pool.blacklistedModels.has(model)) {
    const err = '模型已被禁用（此前超时）';
    onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err });
    throw new Error(err);
  }

  onEvent?.({ type: 'model_plan', stage: 'thinking', model, step });

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await planWithTimeout(model, planCtx, cancelSignal!, undefined);
      onEvent?.({ type: 'model_plan', stage: 'success', model, step, ...planEventPayload(result) });
      return result;
    } catch (err: any) {
      if (isTimeoutError(err)) {
        pool.blacklistedModels.add(model);
        log.warn(`[MultiModel] ${model} 超时，已加入黑名单`);
        onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err.message });
        throw err;
      }
      if (isRateLimitError(err) && attempt < SINGLE_MODEL_RATE_LIMIT_RETRY) {
        // 指数退避：限流通常需要秒级以上的恢复时间，线性重试大概率再次撞墙。
        const backoff = SINGLE_MODEL_RETRY_BASE_BACKOFF_MS * Math.pow(2, attempt);
        log.warn(`[MultiModel] ${model} 触发限流，${Math.round(backoff / 1000)}s 后重试 (${attempt + 1}/${SINGLE_MODEL_RATE_LIMIT_RETRY})`);
        onEvent?.({ type: 'model_plan', stage: 'rate_limited', model, step, cooldown_ms: backoff, error: String(err.message || err).slice(0, 160) });
        await sleepWithCancel(backoff, cancelSignal);
        onEvent?.({ type: 'model_plan', stage: 'thinking', model, step });
        continue;
      }
      onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err.message });
      throw err;
    }
  }
}
