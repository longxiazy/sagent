import { createJsonPlanner } from '../core/planner.ts';
import { normalizeDesktopAgentDecision } from '../core/schemas.ts';
import { displayWidth, padEndW } from '../core/utils.ts';
import { aggregateModelResults } from '../core/multi-model.ts';
import {
  buildClaudeTaskMessages,
  buildDesktopAgentSystemPrompt,
  buildNvidiaTaskMessages,
} from '../core/prompts.ts';
import { isClaudeModel, claudeAgentPlan } from '../core/ai-client.ts';
import { log } from '../../helpers/logger.ts';

export const DEFAULT_MODEL_TIMEOUT_MS = 10_000;

function toolUseToNormalizedDecision(toolUse: any) {
  const { name, input } = toolUse;
  if (!name || !input) {
    throw new Error(`无效的工具调用: ${JSON.stringify(toolUse)}`);
  }
  const action = { type: name, ...input };
  return normalizeDesktopAgentDecision({ action });
}

async function singleModelPlan({ model, openai_client, anthropic_client, modelConfig, cancelSignal, raceSignal, ...context }: any) {
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
    if (isClaudeModel(model, modelConfig)) {
      const system = buildDesktopAgentSystemPrompt(context.systemPrompt);
      const messages = buildClaudeTaskMessages(context);
      const result = await claudeAgentPlan({
        client: anthropic_client,
        model,
        maxTokens: 16000,
        temperature: 0.1,
        system,
        messages,
        signal: ac.signal,
      });
      const decision = toolUseToNormalizedDecision(result.content);
      const usage = result.usage
        ? { prompt_tokens: result.usage.input_tokens || 0, completion_tokens: result.usage.output_tokens || 0 }
        : null;
      return { ...decision, usage, model };
    }

    if (!openai_client) throw new Error(`模型 ${model} 需要 NVIDIA_API_KEY`);
    const planner = createJsonPlanner({
      client: openai_client,
      buildMessages: (ctx: any) =>
        buildNvidiaTaskMessages({ ...ctx, conversationHistory: context.conversationHistory }),
      normalizeDecision: normalizeDesktopAgentDecision,
      buildParserError(err: Error) {
        return `模型动作解析失败: ${err.message}`;
      },
    });
    const result = await planner({ model, signal: ac.signal, ...context });
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
}

export function createDesktopPlanner({
  openai_client,
  anthropic_client,
  modelConfig,
  blacklistedModels,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  staggerDelayMs = 0,
  batchSize = 1,
}: any) {
  function planWithTimeout(model: string, context: any, cancelSignal: AbortSignal, raceSignal?: AbortSignal) {
    const timeoutMs = typeof modelTimeoutMs === 'number' && modelTimeoutMs > 0 ? modelTimeoutMs : DEFAULT_MODEL_TIMEOUT_MS;
    const startedAt = Date.now();
    logModelRequest(model, context.step, timeoutMs);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`模型超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
    });

    return Promise.race([
      singleModelPlan({ model, openai_client, anthropic_client, modelConfig, cancelSignal, raceSignal, ...context }),
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
      try {
        const result = await planWithTimeout(model, planCtx, cancelSignal, undefined);
        onEvent?.({ type: 'model_plan', stage: 'success', model, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
        return result;
      } catch (err: any) {
        if (err.message.includes('模型超时')) {
          blacklistedModels.add(model);
          log.warn(`[MultiModel] ${model} 超时，已加入黑名单`);
        }
        onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err.message });
        throw err;
      }
    }

    const allModels = [model, ...extraModels];
    let activeModels = allModels.filter((candidate: string) => !blacklistedModels.has(candidate));

    log.info(`[MultiModel] step=${step} allModels=[${allModels}] blacklisted=[${[...blacklistedModels]}] activeModels=[${activeModels}]`);

    if (activeModels.length === 0) {
      log.warn('[MultiModel] 所有模型均已被禁用，重置黑名单重试');
      blacklistedModels.clear();
      activeModels = [...allModels];
    }

    onEvent?.({ type: 'model_plan', stage: 'start', models: allModels, strategy, step });

    for (const candidate of allModels) {
      if (blacklistedModels.has(candidate)) {
        onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: '模型已被禁用（此前超时）' });
      }
    }

    if (strategy === 'vote') {
      for (const candidate of activeModels) {
        onEvent?.({ type: 'model_plan', stage: 'thinking', model: candidate, step });
      }

      const settled = await Promise.allSettled(
        activeModels.map((candidate: string) =>
          planWithTimeout(candidate, planCtx, cancelSignal, undefined)
            .then(result => {
              log.debug(`[MultiModel] step=${step} model=${candidate} succeeded: ${result.action?.tool}.${result.action?.type}`);
              onEvent?.({ type: 'model_plan', stage: 'success', model: candidate, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
              return { ...result, model: candidate };
            })
            .catch((err: any) => {
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

    return new Promise((resolve, reject) => {
      let settled = false;
      let launched = 0;
      const failures: string[] = [];
      const timers: NodeJS.Timeout[] = [];
      const raceAc = new AbortController();

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
            }
            log.debug(`[MultiModel] ${candidate} 失败: ${err.message.slice(0, 80)}`);
            onEvent?.({ type: 'model_plan', stage: 'failed', model: candidate, step, error: err.message.slice(0, 120) });
            failures.push(candidate);
            if (launched === failures.length) {
              tryLaunchBatch(true);
            }
            if (!settled && launched === activeModels.length && launched === failures.length) {
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
