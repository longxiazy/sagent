/**
 * race —— UI「竞速」，前端默认策略。
 *
 * 按 batchSize 分批启动，批与批之间隔 staggerDelaySec；首个返回有效结果的胜出，
 * 其余立即 abort。排在前面的模型因此承担主要工作，这正是动态模型路由重排顺序的意义。
 *
 * 「整批全失败就跳过延迟、立刻放下一批」是 race 独有的规则：既然这批已无希望，
 * 再等下去只是白白拖慢这一步。
 */

import { log } from '../../../../helpers/logger.ts';
import { cancelledError, handleModelFailure, planEventPayload } from '../shared.ts';
import type { RaceStrategyContext } from './types.ts';

export function runRaceStrategy({
  activeModels,
  planCtx,
  planWithTimeout,
  pool,
  onEvent,
  cancelSignal,
  step,
  staggerDelayMs,
  batchSize,
}: RaceStrategyContext): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let launched = 0;
    const failures: string[] = [];
    const timers: NodeJS.Timeout[] = [];
    const raceAc = new AbortController();

    if (cancelSignal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onCancel = () => {
      if (settled) return;
      settled = true;
      timers.forEach(timer => clearTimeout(timer));
      reject(cancelledError());
    };
    cancelSignal?.addEventListener('abort', onCancel);

    function launchModel(candidate: string) {
      if (settled || cancelSignal?.aborted) return;
      launched++;
      onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
      planWithTimeout(candidate, planCtx, cancelSignal!, raceAc.signal)
        .then(result => {
          // 已有胜者时后到的结果仍记入 trace（标记 cancelled），便于事后对比各模型表现。
          if (settled) {
            onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step, ...planEventPayload(result) });
            return;
          }
          settled = true;
          raceAc.abort();
          timers.forEach(timer => clearTimeout(timer));
          cancelSignal?.removeEventListener('abort', onCancel);
          log.info(`[MultiModel] 使用 ${candidate} 的结果（${activeModels.join(', ')}）`);
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

          // 已启动的全军覆没 → 这批没戏了，不必等错峰延迟，立刻放下一批。
          if (launched === failures.length) {
            tryLaunchBatch();
          }
          // 所有模型都启动过且都失败，才算这一步彻底失败。
          if (!settled && launched === activeModels.length && launched === failures.length) {
            cancelSignal?.removeEventListener('abort', onCancel);
            reject(new Error(`所有模型均失败: ${failures.join(', ')}`));
          }
        });
    }

    let nextIndex = 0;
    let pendingBatchTimer: NodeJS.Timeout | null = null;

    function tryLaunchBatch() {
      if (settled || cancelSignal?.aborted || nextIndex >= activeModels.length) return;

      // 定时器与「整批失败」都会调到这里。先撤掉已排定的定时器，否则同一批会被
      // 两条路径各推进一次——nextIndex 已前移，实际效果是跳过一批模型。
      if (pendingBatchTimer) {
        clearTimeout(pendingBatchTimer);
        pendingBatchTimer = null;
      }

      const batch = activeModels.slice(nextIndex, nextIndex + batchSize);
      nextIndex += batch.length;

      for (const candidate of batch) launchModel(candidate);

      // 排定下一批：错峰的本意是「先给前面的模型一段独占时间，到点没胜出再加人」，
      // 所以推进必须由时间驱动。此前只在整批失败时才推进，导致前面的模型只要还在跑，
      // 后面的批次就永远停在原地，staggerDelayMs 形同虚设。
      if (nextIndex >= activeModels.length) return;

      // 让前端把待启动的模型显示为排队态，并告知还要等多久。
      for (const candidate of activeModels.slice(nextIndex, nextIndex + batchSize)) {
        onEvent?.({ type: 'model_plan', stage: 'pending', model: candidate, step, delay: staggerDelayMs });
      }

      if (staggerDelayMs <= 0) {
        tryLaunchBatch();
        return;
      }
      pendingBatchTimer = setTimeout(tryLaunchBatch, staggerDelayMs);
      timers.push(pendingBatchTimer);
    }

    tryLaunchBatch();
  });
}
