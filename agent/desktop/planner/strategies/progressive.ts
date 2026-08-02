/**
 * progressive —— 未接入 UI，仅 API 直调可用。
 *
 * 先只跑主模型；PROGRESSIVE_RACE_UP_MS 内出结果就独占，超时未返回或主模型提前
 * 失败，才唤醒其余模型加入竞速。主模型通常够用时比 race 更省 token。
 *
 * 前端只发 race/vote，但 POST /api/agent 的 strategy 不做白名单校验，
 * 因此该分支可达且有测试覆盖，不是死代码。
 */

import { log } from '../../../../helpers/logger.ts';
import { PROGRESSIVE_RACE_UP_MS, cancelledError, handleModelFailure, planEventPayload } from '../shared.ts';
import type { StrategyContext } from './types.ts';

export function runProgressiveStrategy({
  activeModels,
  planCtx,
  planWithTimeout,
  pool,
  onEvent,
  cancelSignal,
  step,
}: StrategyContext): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const failures: string[] = [];
    const timers: NodeJS.Timeout[] = [];
    const raceAc = new AbortController();
    // 主模型可能被定时器和失败回调同时唤醒，用它保证每个模型只启动一次。
    const launchedSet = new Set<string>();

    if (cancelSignal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onCancel = () => {
      if (settled) return;
      settled = true;
      timers.forEach(t => clearTimeout(t));
      raceAc.abort();
      reject(cancelledError());
    };
    cancelSignal?.addEventListener('abort', onCancel);

    const primary = activeModels[0];
    const rest = activeModels.slice(1);

    function launch(candidate: string) {
      if (settled || launchedSet.has(candidate) || cancelSignal?.aborted) return;
      launchedSet.add(candidate);
      onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
      planWithTimeout(candidate, planCtx, cancelSignal!, raceAc.signal)
        .then(result => {
          if (settled) {
            onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step, ...planEventPayload(result) });
            return;
          }
          settled = true;
          raceAc.abort();
          timers.forEach(t => clearTimeout(t));
          cancelSignal?.removeEventListener('abort', onCancel);
          log.info(`[MultiModel] progressive 使用 ${candidate} 的结果`);
          onEvent?.({ type: 'model_plan', stage: 'winner', model: candidate, step, ...planEventPayload(result) });
          resolve(result);
        })
        .catch((err: any) => {
          if (settled) {
            onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step });
            return;
          }
          handleModelFailure(pool, candidate, err, onEvent, step);
          failures.push(candidate);

          // 主模型提前失败 → 不必等满阈值，立即唤醒其余模型兜底。
          if (candidate === primary && rest.length > 0) {
            for (const m of rest) launch(m);
            return;
          }

          if (!settled && launchedSet.size === activeModels.length && failures.length === activeModels.length) {
            cancelSignal?.removeEventListener('abort', onCancel);
            reject(new Error(`所有模型均失败: ${failures.join(', ')}`));
          }
        });
    }

    launch(primary);

    // 主模型迟迟不返回 → 到点唤醒其余模型加入竞速。
    if (rest.length > 0) {
      timers.push(setTimeout(() => {
        if (settled) return;
        log.info(`[MultiModel] progressive primary=${primary} 超过 ${PROGRESSIVE_RACE_UP_MS}ms 未返回，唤醒 ${rest.join(',')}`);
        for (const m of rest) launch(m);
      }, PROGRESSIVE_RACE_UP_MS));
    }
  });
}
