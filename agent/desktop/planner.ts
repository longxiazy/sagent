import { aggregateModelResults } from '../core/multi-model.ts';
import { displayWidth, padEndW } from '../core/utils.ts';
import { log } from '../../helpers/logger.ts';
import { extractErrorDiagnostics } from '../../helpers/retry.ts';

export const DEFAULT_MODEL_TIMEOUT_MS = 10_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const SINGLE_MODEL_RATE_LIMIT_RETRY = 2;
const SINGLE_MODEL_RETRY_BASE_BACKOFF_MS = 5_000;
// progressive 策略下,primary 模型多久还没返回就唤醒剩余模型加入 race
// 选 4s 是因为快速模型一般 2~3s 出结果,留 1s 缓冲避免过早 fan-out 浪费 token
const PROGRESSIVE_RACE_UP_MS = 4_000;

function isRateLimitError(err: any) {
  const status = err?.status || err?.statusCode || err?.error?.status || err?.error?.statusCode;
  const message = String(err?.message || '');
  return status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
}

function sleepWithCancel(ms: number, cancelSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancelSignal?.aborted) {
      reject(new Error('Agent 已取消'));
      return;
    }
    const onCancel = () => {
      clearTimeout(timer);
      reject(new Error('Agent 已取消'));
    };
    const timer = setTimeout(() => {
      cancelSignal?.removeEventListener('abort', onCancel);
      resolve();
    }, ms);
    cancelSignal?.addEventListener('abort', onCancel, { once: true });
  });
}

async function singleModelPlan({ model, registry, modelConfig, cancelSignal, raceSignal, ...context }: any) {
  if (cancelSignal?.aborted) throw new Error('Agent 已取消');

  const ac = new AbortController();
  const onUserCancel = () => ac.abort();
  const onRaceAbort = () => ac.abort();
  if (cancelSignal) {
    if (cancelSignal.aborted) { ac.abort(); } else { cancelSignal.addEventListener('abort', onUserCancel); }
  }
  if (raceSignal) {
    if (raceSignal.aborted) { ac.abort(); } else { raceSignal.addEventListener('abort', onRaceAbort); }
  }

  try {
    const provider = registry.resolve(model, modelConfig);
    const result = await provider.agentPlan({ model, signal: ac.signal, modelConfig, ...context });
    return { ...result, model };
  } finally {
    if (cancelSignal) cancelSignal.removeEventListener('abort', onUserCancel);
    if (raceSignal) raceSignal.removeEventListener('abort', onRaceAbort);
  }
}

function logModelRequest(model: string, step: number | undefined, timeoutMs: number) {
  const shortModel = model.split('/').pop();
  const reqLine = `  >>> LLM REQUEST  ${shortModel}  step=${step ?? '-'}  timeout=${Math.round(timeoutMs / 1000)}s`;
  const width = Math.max(displayWidth(reqLine) + 4, 52);
  log.info(`\n  ${'╔' + '═'.repeat(width) + '╗'}\n  ║${padEndW(reqLine, width)}║\n  ${'╚' + '═'.repeat(width) + '╝'}`);
}

function logModelResponse(model: string, elapsedMs: number, result: any) {
  const shortModel = model.split('/').pop();
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const tokens = (result.usage?.prompt_tokens || 0) + (result.usage?.completion_tokens || 0);
  const resLine = `  <<< LLM RESPONSE ${shortModel}  ${elapsed}s  ${result.action?.tool || '?'}.${result.action?.type || '?'}  ${tokens}tok`;
  const width = Math.max(displayWidth(resLine) + 4, 52);
  log.info(`\n  ${'╔' + '═'.repeat(width) + '╗'}\n  ║${padEndW(resLine, width)}║\n  ${'╚' + '═'.repeat(width) + '╝'}`);
}

function logModelFailure(model: string, elapsedMs: number, err: any) {
  const shortModel = model.split('/').pop();
  const elapsed = (elapsedMs / 1000).toFixed(1);
  if (err.name === 'AbortError' || err.message?.includes('aborted')) {
    const line = `  ··· RACE_ABORT  ${shortModel}  ${elapsed}s`;
    const width = Math.max(displayWidth(line) + 4, 52);
    log.info(`\n  ${'╔' + '═'.repeat(width) + '╗'}\n  ║${padEndW(line, width)}║\n  ${'╚' + '═'.repeat(width) + '╝'}`);
    return;
  }

  const errLine = `  !!! LLM FAILED   ${shortModel}  ${elapsed}s  ${err.message.slice(0, 60)}`;
  const width = Math.max(displayWidth(errLine) + 4, 52);
  log.warn(`\n  ${'╔' + '═'.repeat(width) + '╗'}\n  ║${padEndW(errLine, width)}║\n  ${'╚' + '═'.repeat(width) + '╝'}`);
  log.warn(`[LLM Failure] model=${model} elapsed=${elapsed}s diagnostics=${JSON.stringify(extractErrorDiagnostics(err))}`);
}

export function createDesktopPlanner({
  registry,
  modelConfig,
  blacklistedModels,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  staggerDelayMs = 0,
  batchSize = 1,
  rateLimitCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
}: any) {
  const modelCooldownUntil = new Map<string, number>();

  function isModelCoolingDown(model: string) {
    const until = modelCooldownUntil.get(model) || 0;
    if (until <= Date.now()) {
      modelCooldownUntil.delete(model);
      return false;
    }
    return true;
  }

  function markModelRateLimited(model: string, err: any, onEvent?: any, step?: number) {
    const until = Date.now() + rateLimitCooldownMs;
    modelCooldownUntil.set(model, until);
    const seconds = Math.ceil(rateLimitCooldownMs / 1000);
    log.warn(`[MultiModel] ${model} 触发限流，暂停 ${seconds}s: ${err.message}`);
    onEvent?.({
      type: 'model_plan',
      stage: 'rate_limited',
      model,
      step,
      cooldown_ms: rateLimitCooldownMs,
      error: String(err.message || err).slice(0, 160),
    });
  }

  function planWithTimeout(model: string, context: any, cancelSignal: AbortSignal, raceSignal?: AbortSignal) {
    const timeoutMs = typeof modelTimeoutMs === 'number' && modelTimeoutMs > 0 ? modelTimeoutMs : DEFAULT_MODEL_TIMEOUT_MS;
    const startedAt = Date.now();
    logModelRequest(model, context.step, timeoutMs);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`模型超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
    });

    return Promise.race([
      singleModelPlan({ model, registry, modelConfig, cancelSignal, raceSignal, ...context }),
      timeout,
    ])
      .then(result => {
        logModelResponse(model, Date.now() - startedAt, result);
        return result;
      })
      .catch(err => {
        logModelFailure(model, Date.now() - startedAt, err);
        throw err;
      })
      .finally(() => clearTimeout(timer));
  }

  return async ({ model, agentModels, strategy = 'race', onEvent, cancelSignal, step, ...context }: any) => {
    const extraModels = Array.isArray(agentModels) && agentModels.length > 1
      ? agentModels.filter((candidate: string) => candidate !== model)
      : [];
    const planCtx = { ...context, step };

    if (extraModels.length === 0) {
      onEvent?.({ type: 'model_plan', stage: 'start', models: [model], step });
      if (blacklistedModels.has(model)) {
        const err = '模型已被禁用（此前超时）';
        onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err });
        throw new Error(err);
      }
      onEvent?.({ type: 'model_plan', stage: 'thinking', model, step });
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await planWithTimeout(model, planCtx, cancelSignal, undefined);
          onEvent?.({ type: 'model_plan', stage: 'success', model, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
          return result;
        } catch (err: any) {
          if (err.message.includes('模型超时')) {
            blacklistedModels.add(model);
            log.warn(`[MultiModel] ${model} 超时，已加入黑名单`);
            onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err.message });
            throw err;
          }
          if (isRateLimitError(err) && attempt < SINGLE_MODEL_RATE_LIMIT_RETRY) {
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

    const allModels = [model, ...extraModels];
    let activeModels = allModels.filter((candidate: string) => !blacklistedModels.has(candidate) && !isModelCoolingDown(candidate));

    log.info(`[MultiModel] step=${step} allModels=[${allModels}] blacklisted=[${[...blacklistedModels]}] cooling=[${[...modelCooldownUntil.keys()]}] activeModels=[${activeModels}]`);

    if (activeModels.length === 0 && allModels.every((candidate: string) => blacklistedModels.has(candidate))) {
      log.warn('[MultiModel] 所有模型均已被禁用，重置黑名单重试');
      blacklistedModels.clear();
      activeModels = [...allModels];
    }

    if (activeModels.length === 0) {
      const err = '所有模型均处于限流冷却或禁用状态';
      onEvent?.({ type: 'model_plan', stage: 'failed', step, error: err });
      throw new Error(err);
    }

    onEvent?.({ type: 'model_plan', stage: 'start', models: allModels, strategy, step });

    for (const candidate of allModels) {
      if (blacklistedModels.has(candidate)) {
        onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: '模型已被禁用（此前超时）' });
      } else if (isModelCoolingDown(candidate)) {
        onEvent?.({ type: 'model_plan', stage: 'rate_limited', model: candidate, step, error: '模型限流冷却中' });
      }
    }

    if (strategy === 'vote') {
      for (const candidate of activeModels) {
        onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
      }

      const votePromise = Promise.allSettled(
        activeModels.map((candidate: string) =>
          planWithTimeout(candidate, planCtx, cancelSignal, undefined)
            .then(result => {
              log.debug(`[MultiModel] step=${step} model=${candidate} succeeded: ${result.action?.tool}.${result.action?.type}`);
              onEvent?.({ type: 'model_plan', stage: 'success', model: candidate, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
              return { ...result, model: candidate };
            })
            .catch((err: any) => {
              if (isRateLimitError(err)) {
                markModelRateLimited(candidate, err, onEvent, step);
              }
              if (err.message.includes('模型超时')) {
                blacklistedModels.add(candidate);
                log.warn(`[MultiModel] ${candidate} 超时，已加入黑名单`);
              }
              log.debug(`[MultiModel] ${candidate} 失败: ${err.message.slice(0, 80)}`);
              onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: err.message.slice(0, 120) });
              return null;
            })
        )
      );

      // Race the vote against cancel so we don't wait for all models to timeout
      const cancelPromise = cancelSignal
        ? new Promise<typeof votePromise>((_, reject) => {
            if (cancelSignal.aborted) { reject(new Error('Agent 已取消')); return; }
            const onAbort = () => { cancelSignal.removeEventListener('abort', onAbort); reject(new Error('Agent 已取消')); };
            cancelSignal.addEventListener('abort', onAbort);
            votePromise.finally(() => cancelSignal.removeEventListener('abort', onAbort));
          })
        : new Promise(() => {});

      const settled = await Promise.race([votePromise, cancelPromise]) as PromiseSettledResult<any>[];

      const successes = settled
        .filter((result: any) => result.status === 'fulfilled' && result.value !== null)
        .map((result: any) => result.value);

      if (successes.length === 0) {
        throw new Error(`所有模型均失败: ${activeModels.join(', ')}`);
      }

      const aggregated = aggregateModelResults(successes);
      if (aggregated.consensus) {
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

      return aggregated;
    }

    if (strategy === 'progressive') {
      // 先单跑 primary（activeModels[0]）；4s 内出结果直接独占,
      // 超过阈值仍 thinking → 唤醒剩余模型加入 race；primary 提前 fail → 立即 fallback race
      return new Promise((resolve, reject) => {
        let settled = false;
        const failures: string[] = [];
        const timers: NodeJS.Timeout[] = [];
        const raceAc = new AbortController();
        const launchedSet = new Set<string>();

        if (cancelSignal?.aborted) { reject(new Error('Agent 已取消')); return; }
        const onCancel = () => {
          if (settled) return;
          settled = true;
          timers.forEach(t => clearTimeout(t));
          raceAc.abort();
          reject(new Error('Agent 已取消'));
        };
        cancelSignal?.addEventListener('abort', onCancel);

        const primary = activeModels[0];
        const rest = activeModels.slice(1);

        function launch(candidate: string) {
          if (settled || launchedSet.has(candidate) || cancelSignal?.aborted) return;
          launchedSet.add(candidate);
          onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
          planWithTimeout(candidate, planCtx, cancelSignal, raceAc.signal)
            .then(result => {
              if (settled) {
                onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
                return;
              }
              settled = true;
              raceAc.abort();
              timers.forEach(t => clearTimeout(t));
              cancelSignal?.removeEventListener('abort', onCancel);
              log.info(`[MultiModel] progressive 使用 ${candidate} 的结果`);
              onEvent?.({ type: 'model_plan', stage: 'winner', model: candidate, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
              resolve(result);
            })
            .catch((err: any) => {
              if (settled) {
                onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step });
                return;
              }
              if (err.message.includes('模型超时')) {
                blacklistedModels.add(candidate);
                log.warn(`[MultiModel] ${candidate} 超时，已加入黑名单`);
              } else if (isRateLimitError(err)) {
                markModelRateLimited(candidate, err, onEvent, step);
              }
              onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: err.message.slice(0, 120) });
              failures.push(candidate);

              // primary 提前失败 → 立即唤醒剩余模型 race
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

        if (rest.length > 0) {
          timers.push(setTimeout(() => {
            if (settled) return;
            log.info(`[MultiModel] progressive primary=${primary} 超过 ${PROGRESSIVE_RACE_UP_MS}ms 未返回，唤醒 ${rest.join(',')}`);
            for (const m of rest) launch(m);
          }, PROGRESSIVE_RACE_UP_MS));
        }
      });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let launched = 0;
      const failures: string[] = [];
      const timers: NodeJS.Timeout[] = [];
      const raceAc = new AbortController();

      // Reject immediately if already cancelled, or on future cancel
      if (cancelSignal?.aborted) {
        reject(new Error('Agent 已取消'));
        return;
      }
      const onCancel = () => {
        if (settled) return;
        settled = true;
        timers.forEach(timer => clearTimeout(timer));
        reject(new Error('Agent 已取消'));
      };
      cancelSignal?.addEventListener('abort', onCancel);

      function launchModel(candidate: string) {
        if (settled || cancelSignal?.aborted) return;
        launched++;
        onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
        planWithTimeout(candidate, planCtx, cancelSignal, raceAc.signal)
          .then(result => {
            if (settled) {
              onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
              return;
            }
            settled = true;
            raceAc.abort();
            timers.forEach(timer => clearTimeout(timer));
            cancelSignal?.removeEventListener('abort', onCancel);
            log.info(`[MultiModel] 使用 ${candidate} 的结果（${activeModels.join(', ')}）`);
            onEvent?.({ type: 'model_plan', stage: 'winner', model: candidate, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
            resolve(result);
          })
          .catch((err: any) => {
            if (settled) {
              onEvent?.({ type: 'model_plan', stage: 'cancelled', model: candidate, step });
              return;
            }
            if (err.message.includes('模型超时')) {
              blacklistedModels.add(candidate);
              log.warn(`[MultiModel] ${candidate} 超时，已加入黑名单`);
            } else if (isRateLimitError(err)) {
              markModelRateLimited(candidate, err, onEvent, step);
            }
            log.debug(`[MultiModel] ${candidate} 失败: ${err.message.slice(0, 80)}`);
            onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: err.message.slice(0, 120) });
            failures.push(candidate);
            if (launched === failures.length) {
              tryLaunchBatch(true);
            }
            if (!settled && launched === activeModels.length && launched === failures.length) {
              cancelSignal?.removeEventListener('abort', onCancel);
              reject(new Error(`所有模型均失败: ${failures.join(', ')}`));
            }
          });
      }

      let nextIndex = 0;
      function tryLaunchBatch(skipDelay = false) {
        if (settled || cancelSignal?.aborted || nextIndex >= activeModels.length) return;

        const isFirstBatch = nextIndex === 0;
        const batch = activeModels.slice(nextIndex, nextIndex + batchSize);
        nextIndex += batch.length;

        const launchBatch = () => {
          for (const candidate of batch) {
            launchModel(candidate);
          }
        };

        if (isFirstBatch || skipDelay || staggerDelayMs <= 0) {
          launchBatch();
        } else {
          for (const candidate of batch) {
            onEvent?.({ type: 'model_plan', stage: 'pending', model: candidate, step, delay: staggerDelayMs });
          }
          timers.push(setTimeout(launchBatch, staggerDelayMs));
        }
      }

      tryLaunchBatch();
    });
  };
}
