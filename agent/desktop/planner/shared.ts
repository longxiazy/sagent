/**
 * Planner 内部共享部件：常量、错误判定、取消感知的等待，以及三种策略共用的
 * 「单个模型失败了怎么办」。
 *
 * 失败处理之所以要共享：三种策略对失败的反应完全一致——超时拉黑、429 冷却、
 * 发 failed 事件。此前各写一遍，已经出现过顺序不一致（无害但迟早分叉）。
 */

import { log } from '../../../helpers/logger.ts';

export const DEFAULT_MODEL_TIMEOUT_MS = 10_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
export const SINGLE_MODEL_RATE_LIMIT_RETRY = 2;
export const SINGLE_MODEL_RETRY_BASE_BACKOFF_MS = 5_000;
// progressive 策略下，primary 模型多久还没返回就唤醒剩余模型加入 race。
// 选 4s 是因为快速模型一般 2~3s 出结果，留 1s 缓冲避免过早 fan-out 浪费 token。
export const PROGRESSIVE_RACE_UP_MS = 4_000;

export const CANCELLED_MESSAGE = 'Agent 已取消';

export function cancelledError() {
  return new Error(CANCELLED_MESSAGE);
}

// 供应商对限流的表达方式不统一：有的给 status，有的只在文案里体现，故两者都查。
export function isRateLimitError(err: any) {
  const status = err?.status || err?.statusCode || err?.error?.status || err?.error?.statusCode;
  const message = String(err?.message || '');
  return status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
}

export function isTimeoutError(err: any) {
  return String(err?.message || '').includes('模型超时');
}

/** setTimeout 的可取消版本：用户取消时立即 reject，不必空等退避结束。 */
export function sleepWithCancel(ms: number, cancelSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancelSignal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onCancel = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      cancelSignal?.removeEventListener('abort', onCancel);
      resolve();
    }, ms);
    cancelSignal?.addEventListener('abort', onCancel, { once: true });
  });
}

export interface ModelPool {
  blacklistedModels: Set<string>;
  markModelRateLimited(model: string, err: any, onEvent?: any, step?: number): void;
}

/**
 * 处理一个模型的失败：超时拉黑、限流冷却，并发出 failed 事件。
 *
 * 超时与限流分开对待——超时可能是模型本身卡住，本次 run 内不再调度它；
 * 限流只是暂时不可用，冷却过期后仍可参与。
 */
export function handleModelFailure(
  pool: ModelPool,
  model: string,
  err: any,
  onEvent?: any,
  step?: number,
) {
  if (isTimeoutError(err)) {
    pool.blacklistedModels.add(model);
    log.warn(`[MultiModel] ${model} 超时，已加入黑名单`);
  } else if (isRateLimitError(err)) {
    pool.markModelRateLimited(model, err, onEvent, step);
  }
  log.debug(`[MultiModel] ${model} 失败: ${String(err?.message || err).slice(0, 80)}`);
  onEvent?.({
    type: 'model_plan',
    stage: 'failed',
    model,
    step,
    error: String(err?.message || err).slice(0, 120),
  });
}

/** 决策事件的公共字段。胜出/成功/取消三种 stage 都带同一组，抽出来避免各处漏字段。 */
export function planEventPayload(result: any) {
  return {
    rationale: result.rationale,
    action: result.action,
    usage: result.usage,
    reasoning: result.reasoning,
    response: result.response,
    requests: result.requests,
  };
}
