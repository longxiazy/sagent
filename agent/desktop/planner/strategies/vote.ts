/**
 * vote —— UI「汇总」。
 *
 * 一次性启动全部活动模型并等待都结束，再由 multi-model.ts 聚合出多数一致的决策。
 * 延迟取决于最慢的模型、每个模型都会跑满，换来的是更稳的决策质量。
 *
 * 唯一的例外是 finish：收尾动作没有「谁收得更好」的可比性，任一模型返回就短路，
 * 继续等只是白烧 token。
 */

import { aggregateModelResults } from '../../../core/multi-model.ts';
import { log } from '../../../../helpers/logger.ts';
import { cancelledError, handleModelFailure, planEventPayload } from '../shared.ts';
import type { StrategyContext } from './types.ts';

export function runVoteStrategy({
  activeModels,
  planCtx,
  planWithTimeout,
  pool,
  onEvent,
  cancelSignal,
  step,
}: StrategyContext): Promise<any> {
  for (const candidate of activeModels) {
    onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let completed = 0;
    const successes: any[] = [];
    const voteAc = new AbortController();

    const cleanup = () => cancelSignal?.removeEventListener('abort', onCancel);
    const onCancel = () => {
      if (settled) return;
      settled = true;
      voteAc.abort(cancelledError());
      cleanup();
      reject(cancelledError());
    };

    const finishVote = () => {
      // 必须等全部模型有结果（成功或失败）才能汇总，否则票数不完整。
      if (settled || completed < activeModels.length) return;
      settled = true;
      cleanup();
      if (successes.length === 0) {
        reject(new Error(`所有模型均失败: ${activeModels.join(', ')}`));
        return;
      }

      const aggregated = aggregateModelResults(successes);
      if (aggregated.consensus) {
        // 以参与投票的模型总数为分母（含失败者），让「2/3 一致」如实反映分歧程度。
        aggregated.consensus.total = activeModels.length;
        aggregated.consensus.unanimous = aggregated.consensus.agreed === activeModels.length;
      }
      onEvent?.({
        type: 'model_plan',
        stage: 'consensus',
        model: aggregated.model,
        step,
        rationale: aggregated.rationale,
        action: aggregated.action,
        consensus: aggregated.consensus,
      });
      log.info(
        `[MultiModel] 投票结果: ${aggregated.consensus.agreed}/${aggregated.consensus.total} 一致 ` +
        `(${aggregated.consensus.unanimous ? '全票' : '多数'}) → ${aggregated.model}`
      );
      resolve(aggregated);
    };

    if (cancelSignal?.aborted) {
      onCancel();
      return;
    }
    cancelSignal?.addEventListener('abort', onCancel, { once: true });

    for (const candidate of activeModels) {
      planWithTimeout(candidate, planCtx, cancelSignal!, voteAc.signal)
        .then(result => {
          if (settled) {
            onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step, ...planEventPayload(result) });
            return;
          }

          const enriched = { ...result, model: candidate };
          log.debug(`[MultiModel] step=${step} model=${candidate} succeeded: ${result.action?.tool}.${result.action?.type}`);
          onEvent?.({ type: 'model_plan', stage: 'success', model: candidate, step, ...planEventPayload(result) });

          if (result.action?.type === 'finish') {
            settled = true;
            voteAc.abort(new DOMException('已有模型返回 finish', 'AbortError'));
            cleanup();
            log.info(`[MultiModel] ${candidate} 返回 finish，跳过汇总并立即结束`);
            onEvent?.({
              type: 'model_plan',
              stage: 'winner',
              model: candidate,
              step,
              ...planEventPayload(result),
              finishShortCircuit: true,
            });
            resolve(enriched);
            return;
          }

          successes.push(enriched);
          completed += 1;
          finishVote();
        })
        .catch((err: any) => {
          if (settled) {
            onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step });
            return;
          }
          handleModelFailure(pool, candidate, err, onEvent, step);
          // 失败也计入 completed：否则有模型失败时永远凑不齐票数，Promise 永不落定。
          completed += 1;
          finishVote();
        });
    }
  });
}
