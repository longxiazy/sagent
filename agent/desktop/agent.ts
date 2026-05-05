/**
 * Desktop Agent — 浏览器/桌面/文件/终端多工具协同的 Agent 运行器
 * Desktop Agent runtime — orchestrates browser, macOS desktop, filesystem, and terminal tools
 *
 * 核心流程 / Core loop:
 *   initialize → (observe → decide → authorize → execute) × N → cleanup
 *   由 agent/core/runtime.js 驱动单步循环，本文件提供各阶段的实现。
 *
 * 多模型竞速 / Multi-model race:
 *   buildDesktopPlanner() 支持 race / vote 两种策略：
 *   - race: 批量错峰启动，首个有效结果胜出，其余取消
 *   - vote: 等待全部完成，多数投票选最优决策
 *   超时模型自动加入黑名单，批次全部失败时触发下一批。
 *
 * 观测 / Observation:
 *   observeDesktopAgent() 同时采集桌面（AppleScript）和浏览器（Playwright）状态，
 *   合并为统一的 observation 对象供 LLM 决策。
 *
 * 调用场景 / Callers:
 *   - server.js 启动时: createDesktopAgentRunner() 工厂创建 runDesktopAgent 函数
 *   - routes/agent.js POST /api/agent: runDesktopAgent() 执行任务
 *   - server.js resumeFromCheckpoint(): 恢复断点继续执行
 *
 * TODO / 拆分建议 Refactor suggestions:
 *   - 将 multi-model 竞速逻辑（buildDesktopPlanner / aggregateResults）拆到 agent/core/multi-model.js
 *   - 将 message 构建（buildClaudeTaskMessages / buildNvidiaTaskMessages）拆到 agent/core/prompts.js
 *   - 将 observation 采集逻辑拆到 agent/desktop/observer.js
 */

import { createJsonPlanner } from '../core/planner.ts';
import { createActionRouter } from '../core/router.ts';
import { runAgentRuntime } from '../core/runtime.ts';
import { normalizeDesktopAgentDecision } from '../core/schemas.ts';
import { displayWidth, padEndW } from '../core/utils.ts';
import { aggregateModelResults } from '../core/multi-model.ts';
import {
  buildClaudeTaskMessages,
  buildDesktopAgentSystemPrompt,
  buildNvidiaTaskMessages,
} from '../core/prompts.ts';
import { createAgentAuthorizer } from '../policy/approvals.ts';
import { executeBrowserAction } from '../tools/browser/execute.ts';
import { closeBrowserSession, createBrowserSession } from '../tools/browser/webview-session.ts';
import { executeFsAction } from '../tools/fs/execute.ts';
import { createDomainRules } from '../tools/fetch/domain-rules.ts';
import { executeIdeAction } from '../tools/ide/execute.ts';
import { executeMacOSAction } from '../tools/macos/execute.ts';
import { executeTerminalAction } from '../tools/terminal/run.ts';
import { observeDesktopAgent } from './observer.ts';
import { isClaudeModel, claudeAgentPlan } from '../core/ai-client.ts';
import { saveCheckpoint } from '../core/checkpoint.ts';
import { log } from '../../helpers/logger.ts';

function toolUseToNormalizedDecision(toolUse) {
  const { name, input } = toolUse;
  if (!name || !input) {
    throw new Error(`无效的工具调用: ${JSON.stringify(toolUse)}`);
  }
  const action = { type: name, ...input };
  return normalizeDesktopAgentDecision({ action });
}

async function singleModelPlan({ model, openai_client, anthropic_client, modelConfig, cancelSignal, raceSignal, ...context }) {
  if (cancelSignal?.aborted) throw new Error('Agent 已取消');

  // Create an AbortController that fires on user cancel OR race winner
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
      const messages = buildClaudeTaskMessages(context as any);
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
    } else {
      if (!openai_client) throw new Error(`模型 ${model} 需要 NVIDIA_API_KEY`);
      const planner = createJsonPlanner({
        client: openai_client,
        buildMessages: (ctx) =>
          buildNvidiaTaskMessages({ ...ctx, conversationHistory: context.conversationHistory }),
        normalizeDecision: normalizeDesktopAgentDecision,
        buildParserError(err) {
          return `模型动作解析失败: ${err.message}`;
        },
      });
      const result = await planner({ model, signal: ac.signal, ...context });
      return { ...result, model };
    }
  } finally {
    if (cancelSignal) cancelSignal.removeEventListener('abort', onUserCancel);
    if (raceSignal) raceSignal.removeEventListener('abort', onRaceAbort);
  }
}

const DEFAULT_MODEL_TIMEOUT_MS = 10_000;

function buildDesktopPlanner({ openai_client, anthropic_client, modelConfig, blacklistedModels, modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS, staggerDelayMs = 0, batchSize = 1 }) {
  function planWithTimeout(model, context, cancelSignal, raceSignal) {
    const timeoutMs = typeof modelTimeoutMs === 'number' && modelTimeoutMs > 0 ? modelTimeoutMs : DEFAULT_MODEL_TIMEOUT_MS;
    const shortModel = model.split('/').pop();
    const startTime = Date.now();
    const reqLine = `  >>> LLM REQUEST  ${shortModel}  step=${context.step ?? '-'}  timeout=${Math.round(timeoutMs / 1000)}s`;
    const w = Math.max(displayWidth(reqLine) + 4, 52);
    log.info(`\n  ${'╔' + '═'.repeat(w) + '╗'}\n  ║${padEndW(reqLine, w)}║\n  ${'╚' + '═'.repeat(w) + '╝'}`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`模型超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
    });
    return Promise.race([
      singleModelPlan({ model, openai_client, anthropic_client, modelConfig, cancelSignal, raceSignal, ...context }),
      timeout,
    ])
      .then(result => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const tokens = (result.usage?.prompt_tokens || 0) + (result.usage?.completion_tokens || 0);
        const resLine = `  <<< LLM RESPONSE ${shortModel}  ${elapsed}s  ${result.action?.tool || '?'}.${result.action?.type || '?'}  ${tokens}tok`;
        const rw = Math.max(displayWidth(resLine) + 4, 52);
        log.info(`\n  ${'╔' + '═'.repeat(rw) + '╗'}\n  ║${padEndW(resLine, rw)}║\n  ${'╚' + '═'.repeat(rw) + '╝'}`);
        return result;
      })
      .catch(err => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (err.name === 'AbortError' || err.message?.includes('aborted')) {
          const line = `  ··· RACE_ABORT  ${shortModel}  ${elapsed}s`;
          const w = Math.max(displayWidth(line) + 4, 52);
          log.info(`\n  ${'╔' + '═'.repeat(w) + '╗'}\n  ║${padEndW(line, w)}║\n  ${'╚' + '═'.repeat(w) + '╝'}`);
        } else {
          const errLine = `  !!! LLM FAILED   ${shortModel}  ${elapsed}s  ${err.message.slice(0, 60)}`;
          const ew = Math.max(displayWidth(errLine) + 4, 52);
          log.warn(`\n  ${'╔' + '═'.repeat(ew) + '╗'}\n  ║${padEndW(errLine, ew)}║\n  ${'╚' + '═'.repeat(ew) + '╝'}`);
        }
        throw err;
      })
      .finally(() => clearTimeout(timer));
  }

  return async ({ model, agentModels, strategy = 'race', onEvent, cancelSignal, step, ...context }) => {
    const extraModels = Array.isArray(agentModels) && agentModels.length > 1
      ? agentModels.filter(m => m !== model)
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
      } catch (err) {
        if (err.message.includes('模型超时')) {
          blacklistedModels.add(model);
          log.warn(`[MultiModel] ${model} 超时，已加入黑名单`);
        }
        onEvent?.({ type: 'model_plan', stage: 'failed', model, step, error: err.message });
        throw err;
      }
    }

    const allModels = [model, ...extraModels];
    let activeModels = allModels.filter(m => !blacklistedModels.has(m));

    log.info(`[MultiModel] step=${step} allModels=[${allModels}] blacklisted=[${[...blacklistedModels]}] activeModels=[${activeModels}]`);

    if (activeModels.length === 0) {
      log.warn(`[MultiModel] 所有模型均已被禁用，重置黑名单重试`);
      blacklistedModels.clear();
      activeModels = [...allModels];
    }

    onEvent?.({ type: 'model_plan', stage: 'start', models: allModels, strategy, step });

    // Emit skipped for blacklisted models
    for (const m of allModels) {
      if (blacklistedModels.has(m)) {
        onEvent?.({ type: 'model_plan', stage: 'failed', model: m, step, error: '模型已被禁用（此前超时）' });
      }
    }

    // === VOTE MODE: wait for all, then aggregate ===
    if (strategy === 'vote') {
      for (const m of activeModels) {
        onEvent?.({ type: 'model_plan', stage: 'thinking', model: m, step });
      }

      const settled = await Promise.allSettled(
        activeModels.map(m =>
	          planWithTimeout(m, planCtx, cancelSignal, undefined)
            .then(result => {
              log.debug(`[MultiModel] step=${step} model=${m} succeeded: ${result.action?.tool}.${result.action?.type}`);
              onEvent?.({ type: 'model_plan', stage: 'success', model: m, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
              return { ...result, model: m };
            })
            .catch(err => {
              if (err.message.includes('模型超时')) {
                blacklistedModels.add(m);
                log.warn(`[MultiModel] ${m} 超时，已加入黑名单`);
              }
              log.debug(`[MultiModel] ${m} 失败: ${err.message.slice(0, 80)}`);
              onEvent?.({ type: 'model_plan', stage: 'failed', model: m, step, error: err.message.slice(0, 120) });
              return null;
            })
        )
      );

      const successes = settled
        .filter((r: any) => r.status === 'fulfilled' && r.value !== null)
        .map((r: any) => r.value);

      if (successes.length === 0) {
        throw new Error(`所有模型均失败: ${activeModels.join(', ')}`);
      }

      const aggregated = aggregateModelResults(successes);
      // Fix total to include all active models (not just successes)
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

    // === RACE MODE: batched staggered start, first valid wins ===
    return new Promise((resolve, reject) => {
      let settled = false;
      let launched = 0;
      const failures = [];
      const timers = [];
      const raceAc = new AbortController();

      function launchModel(m) {
        if (settled || cancelSignal?.aborted) return;
        launched++;
        onEvent?.({ type: 'model_plan', stage: 'thinking', model: m, step });
        planWithTimeout(m, planCtx, cancelSignal, raceAc.signal)
          .then(result => {
            if (settled) {
              onEvent?.({ type: 'model_plan', stage: 'cancelled', model: m, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
              return;
            }
            settled = true;
            raceAc.abort();
            timers.forEach(t => clearTimeout(t));
            log.info(`[MultiModel] 使用 ${m} 的结果（${activeModels.join(', ')}）`);
            onEvent?.({ type: 'model_plan', stage: 'winner', model: m, step, rationale: result.rationale, action: result.action, usage: result.usage, reasoning: result.reasoning });
            resolve(result);
          })
          .catch(err => {
            if (settled) {
              onEvent?.({ type: 'model_plan', stage: 'cancelled', model: m, step });
              return;
            }
            if (err.message.includes('模型超时')) {
              blacklistedModels.add(m);
              log.warn(`[MultiModel] ${m} 超时，已加入黑名单`);
            }
            log.debug(`[MultiModel] ${m} 失败: ${err.message.slice(0, 80)}`);
            onEvent?.({ type: 'model_plan', stage: 'failed', model: m, step, error: err.message.slice(0, 120) });
            failures.push(m);
            // Check if entire launched batch has failed → trigger next batch immediately
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
          for (const m of batch) {
            launchModel(m);
          }
        };

        if (isFirstBatch || skipDelay || staggerDelayMs <= 0) {
          launchBatch();
        } else {
          for (const m of batch) {
            onEvent?.({ type: 'model_plan', stage: 'pending', model: m, step, delay: staggerDelayMs });
          }
          timers.push(setTimeout(launchBatch, staggerDelayMs));
        }
      }

      tryLaunchBatch();
    });
  };
}

export function createDesktopAgentRunner({
  openai_client,
  anthropic_client,
  modelConfig,
  maxSteps = 8,
  defaultHeadless = false,
  observeDesktop = false,
  runStore: _runStore,
  approvalStore,
  checkpointDir,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  staggerDelayMs = 0,
  batchSize = 1,
}) {
  const domainRules = createDomainRules(checkpointDir);

  // Shared browser session across runs
  let sharedBrowserSession = null;
  let sharedBrowserHeadless = null;

  async function getSharedBrowserSession(headless, onEvent) {
    if (sharedBrowserSession && sharedBrowserHeadless === headless) {
      return sharedBrowserSession;
    }
    if (sharedBrowserSession) {
      await closeBrowserSession(sharedBrowserSession);
      sharedBrowserSession = null;
    }
    sharedBrowserSession = createBrowserSession();
    sharedBrowserHeadless = headless;
    onEvent?.({
      type: 'status',
      status: 'browser_ready',
      message: 'Bun.WebView 浏览器已启动',
    });
    return sharedBrowserSession;
  }

  async function ensureBrowserSession(state, onEvent) {
    if (state.browserSession) {
      return state.browserSession;
    }
    const session = await getSharedBrowserSession(state.headless, onEvent);
    await session.view.navigate('about:blank').catch(() => {});
    state.browserSession = session;
    return session;
  }

  const routeAction = createActionRouter(
    {
      core: async (state, action, context) => {
        if (action.type === 'notify_user') {
          state.onEvent?.({
            type: 'notification',
            level: action.level || 'info',
            step: context?.step,
            message: action.message,
          });
          return `已发送通知`;
        }
        if (action.type === 'ask_user') {
          return context?.authorization?.response || '用户未回答';
        }
        return action.answer || '任务已完成';
      },
      browser: async (state, action) => {
        const session = await ensureBrowserSession(state, state.onEvent);
        return executeBrowserAction(session.view, action);
      },
      fs: async (_state, action) => executeFsAction(action),
      ide: async (_state, action) => executeIdeAction(action),
      terminal: async (_state, action) => executeTerminalAction(action),
      macos: async (state, action) =>
        executeMacOSAction(action, {
          runId: state.runId,
        }),
    },
    { defaultTool: 'core' }
  );

  async function runDesktopAgent({
    task,
    model,
    models: agentModels,
    strategy = 'race',
    systemPrompt = null,
    headless = defaultHeadless,
    onEvent,
    cancelSignal,
    runId,
    runRecord = null,
    startedAt = Date.now(),
    initialStep = 1,
    initialHistory = [],
    conversationHistory = [],
    memory = true,
  }) {
    const blacklistedModels = new Set();
    const plan = buildDesktopPlanner({ openai_client, anthropic_client, modelConfig, blacklistedModels, modelTimeoutMs, staggerDelayMs, batchSize });

    const authorize = createAgentAuthorizer({
      runId,
      approvalStore,
      onEvent,
    });

    return runAgentRuntime({
      task,
      maxSteps,
      onEvent,
      cancelSignal,
      initialStep,
      initialHistory,
      // v2: 会话级健康检查点支持
      sessionCheckpointDir: checkpointDir,
      runRecord,
      onCheckpoint: checkpointDir
        ? (history, step) => saveCheckpoint(checkpointDir, {
            runId, task, model, systemPrompt, headless,
            history, step, maxSteps, startedAt,
            agentModels, strategy, conversationHistory, memory,
          })
        : null,
      initialize: async () => ({
        runId,
        onEvent,
        headless,
        browserSession: null,
        observeDesktop,
      }),
      observe: observeDesktopAgent,
      decide: async ({ task: currentTask, step, history, observation }) =>
        plan({
          model,
          agentModels,
          strategy,
          onEvent,
          cancelSignal,
          task: currentTask,
          systemPrompt,
          step,
          history,
          observation,
          conversationHistory,
        }),
      authorize,
      shouldObserve: (lastAction) => {
        if (!lastAction) return false;
        const tool = lastAction.tool || '';
        return tool !== 'fs' && tool !== 'terminal';
      },
      execute: async (state, action, context) => routeAction(state, action, context),
      cleanup: async state => {
        if (state.browserSession?.view) {
          await state.browserSession.view.navigate('about:blank').catch(() => {});
        }
      },
    });
  }

  runDesktopAgent.domainRules = domainRules;
  return runDesktopAgent;
}
