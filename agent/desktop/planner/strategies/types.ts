/**
 * 三种调度策略共用的入参契约。
 *
 * 策略只负责「按什么节奏启动这批模型、如何从结果中选出一个决策」；
 * 模型可用性（黑名单/冷却）、超时、日志都由 pool 与 planWithTimeout 处理。
 */

import type { PlanWithTimeout } from '../single-model.ts';
import type { ModelPoolInstance } from '../model-pool.ts';

export interface StrategyContext {
  activeModels: string[];
  planCtx: any;
  planWithTimeout: PlanWithTimeout;
  pool: ModelPoolInstance;
  onEvent?: (payload: any) => void;
  cancelSignal?: AbortSignal;
  step?: number;
}

export interface RaceStrategyContext extends StrategyContext {
  staggerDelayMs: number;
  batchSize: number;
}
