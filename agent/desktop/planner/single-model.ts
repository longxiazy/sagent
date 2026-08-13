/**
 * 单模型调用层：把一次 provider.agentPlan 包装成带超时、日志与请求记录的调用。
 *
 * 三种策略都通过这里发起模型请求，差别只在「什么时候发起、发起几个」。
 */

import { createAbortScope, throwIfAborted } from '../../core/abort.ts';
import { displayWidth, padEndW } from '../../core/utils.ts';
import { log } from '../../../helpers/logger.ts';
import { extractErrorDiagnostics } from '../../../helpers/retry.ts';
import { CANCELLED_MESSAGE, DEFAULT_MODEL_TIMEOUT_MS, attachRequestsToError, cancelledError } from './shared.ts';

function boxed(line: string) {
  const width = Math.max(displayWidth(line) + 4, 52);
  return `\n  ${'╔' + '═'.repeat(width) + '╗'}\n  ║${padEndW(line, width)}║\n  ${'╚' + '═'.repeat(width) + '╝'}`;
}

function logModelRequest(model: string, step: number | undefined, timeoutMs: number) {
  const shortModel = model.split('/').pop();
  log.info(boxed(`  >>> LLM REQUEST  ${shortModel}  step=${step ?? '-'}  timeout=${Math.round(timeoutMs / 1000)}s`));
}

function logModelResponse(model: string, elapsedMs: number, result: any) {
  const shortModel = model.split('/').pop();
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const tokens = (result.usage?.prompt_tokens || 0) + (result.usage?.completion_tokens || 0);
  log.info(boxed(`  <<< LLM RESPONSE ${shortModel}  ${elapsed}s  ${result.action?.tool || '?'}.${result.action?.type || '?'}  ${tokens}tok`));
}

function logModelFailure(model: string, elapsedMs: number, err: any) {
  const shortModel = model.split('/').pop();
  const elapsed = (elapsedMs / 1000).toFixed(1);
  // 竞速中被取消不是故障，只记一行 info，避免把正常的 race 收尾刷成一片警告。
  if (err.name === 'AbortError' || err.message?.includes('aborted')) {
    log.info(boxed(`  ··· RACE_ABORT  ${shortModel}  ${elapsed}s`));
    return;
  }

  log.warn(boxed(`  !!! LLM FAILED   ${shortModel}  ${elapsed}s  ${err.message.slice(0, 60)}`));
  log.warn(`[LLM Failure] model=${model} elapsed=${elapsed}s diagnostics=${JSON.stringify(extractErrorDiagnostics(err))}`);
}

async function singleModelPlan({ model, registry, modelConfig, cancelSignal, raceSignal, deadlineSignal, ...context }: any) {
  if (cancelSignal?.aborted) throw cancelledError();

  // 三路信号任一触发都要中断：用户取消、竞速已有胜者、本模型超时。
  const scope = createAbortScope({ signals: [cancelSignal, raceSignal, deadlineSignal] });

  try {
    const provider = registry.resolve(model, modelConfig);
    throwIfAborted(scope.signal);
    const result = await provider.agentPlan({ model, signal: scope.signal, modelConfig, ...context });
    return { ...result, model };
  } finally {
    scope.cleanup();
  }
}

export type PlanWithTimeout = (
  model: string,
  context: any,
  cancelSignal: AbortSignal,
  raceSignal?: AbortSignal,
) => Promise<any>;

export function createPlanWithTimeout({
  registry,
  modelConfig,
  modelTimeoutMs,
}: {
  registry: any;
  modelConfig: any;
  modelTimeoutMs?: number;
}): PlanWithTimeout {
  return function planWithTimeout(model, context, cancelSignal, raceSignal) {
    const timeoutMs = typeof modelTimeoutMs === 'number' && modelTimeoutMs > 0 ? modelTimeoutMs : DEFAULT_MODEL_TIMEOUT_MS;
    const startedAt = Date.now();
    logModelRequest(model, context.step, timeoutMs);

    const timeoutMessage = `模型超时 (${Math.round(timeoutMs / 1000)}s)`;
    const timeoutScope = createAbortScope({ timeoutMs, timeoutMessage });

    // 记录发给模型的每一次消息体（解析失败重问、工具协议回退都会追加一条），
    // 供前端展示 LLM 请求详情。
    const requests: unknown[][] = [];
    return singleModelPlan({
      model,
      registry,
      modelConfig,
      cancelSignal,
      raceSignal,
      deadlineSignal: timeoutScope.signal,
      ...context,
      onRequest: (messages: unknown[]) => requests.push(messages),
    })
      .then(result => ({ ...result, requests }))
      .catch(err => {
        // 三路信号共用一个 scope，抛出的都是笼统的 abort。只有确属超时信号触发
        // （用户没取消、竞速没结束）才改写成超时错误，否则会把取消误报成超时并拉黑模型。
        if (timeoutScope.signal.aborted && !cancelSignal?.aborted && !raceSignal?.aborted) {
          throw new Error(timeoutMessage);
        }
        throw err;
      })
      .then(result => {
        logModelResponse(model, Date.now() - startedAt, result);
        return result;
      })
      .catch(err => {
        logModelFailure(model, Date.now() - startedAt, err);
        // 把已发出的消息体挂到错误上：失败事件同样要能还原当时的 prompt 输入，
        // 否则超时/解析失败这些最需要复盘的步骤在 trace 里反而查不到请求原文。
        attachRequestsToError(err, requests);
        throw err;
      })
      .finally(() => timeoutScope.cleanup());
  };
}

export { CANCELLED_MESSAGE };
