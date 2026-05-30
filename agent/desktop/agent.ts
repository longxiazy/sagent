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

import { createActionRouter } from '../core/router.ts';
import { runAgentRuntime } from '../core/runtime.ts';
import { createAgentAuthorizer, createReadOnlyAuthorizer } from '../policy/approvals.ts';
import { executeBrowserAction } from '../tools/browser/execute.ts';
import { executeFsAction } from '../tools/fs/execute.ts';
import { executeSearchAction } from '../tools/search/execute.ts';
import { executeVisionAction } from '../tools/vision/execute.ts';
import { executeSpawnAction } from '../tools/spawn/execute.ts';
import { createDomainRules } from '../tools/fetch/domain-rules.ts';
import { executeIdeAction } from '../tools/ide/execute.ts';
import { executeChromeAction } from '../tools/chrome/execute.ts';
import { executeMacOSAction } from '../tools/macos/execute.ts';
import { executeTerminalAction } from '../tools/terminal/run.ts';
import { createSharedBrowserSessionManager } from './browser-session-manager.ts';
import { observeDesktopAgent } from './observer.ts';
import { createDesktopPlanner, DEFAULT_MODEL_TIMEOUT_MS } from './planner.ts';
import { saveCheckpoint } from '../core/checkpoint.ts';
import { log } from '../../helpers/logger.ts';

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
  visionModel,
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  staggerDelayMs = 0,
  batchSize = 1,
}) {
  const domainRules = createDomainRules(checkpointDir);
  const { ensureBrowserSession } = createSharedBrowserSessionManager();

  // Sub-agent runner factory: creates isolated runners for parallel execution
  function createSubAgentRunner(parentRunId: string, parentModel: string, parentAgentModels: string[], parentStrategy: string, parentSystemPrompt: string | null, parentCancelSignal: AbortSignal) {
    const subBrowserManager = createSharedBrowserSessionManager();

    return async (task: string, subIndex: number) => {
      const subRunId = `${parentRunId}::sub${subIndex}`;
      log.info(`[SubAgent] 启动子任务 ${subIndex}: ${task.slice(0, 60)}...`);

      const subBlacklistedModels = new Set();
      const subPlan = createDesktopPlanner({
        openai_client,
        anthropic_client,
        modelConfig,
        blacklistedModels: subBlacklistedModels,
        modelTimeoutMs,
        staggerDelayMs,
        batchSize,
      });

      const subAuthorize = createReadOnlyAuthorizer();

      // Sub-agent action router without spawn support
      const subRouteAction = createActionRouter(
        {
          core: async (state, action, context) => {
            if (action.type === 'notify_user') {
              return `已发送通知`;
            }
            if (action.type === 'ask_user') {
              return '子 Agent 不支持交互式提问';
            }
            return action.answer || '任务已完成';
          },
          browser: async (state, action) => {
            const session = await subBrowserManager.ensureBrowserSession(state, undefined);
            return executeBrowserAction(session.view, action);
          },
          fs: async (_state, action) => executeFsAction(action),
          search: async (_state, action) => executeSearchAction(action),
          vision: async (_state, action) => executeVisionAction(action, { openai_client, visionModel }),
          ide: async (_state, action) => executeIdeAction(action),
          chrome: async (_state, action) => executeChromeAction(action),
          terminal: async (_state, action) => executeTerminalAction(action),
          macos: async (state, action) => executeMacOSAction(action, { runId: state.runId }),
          spawn: async () => {
            throw new Error('子 Agent 不支持嵌套 spawn 调用');
          },
        },
        { defaultTool: 'core' }
      );

      const subSystemPrompt = [
        '你是一个子 Agent，负责完成主 Agent 分配的独立子任务。',
        '你只能使用只读工具（浏览器、搜索、文件读取等），不能执行需要用户确认的操作。',
        '完成任务后必须通过 finish 动作返回结果。',
        parentSystemPrompt ? `主 Agent 的约束: ${parentSystemPrompt}` : '',
      ].filter(Boolean).join('\n');

      const result = await runAgentRuntime({
        task,
        maxSteps: Math.min(6, maxSteps),
        onEvent: undefined, // Sub-agents don't emit events to parent stream
        cancelSignal: parentCancelSignal,
        initialStep: 1,
        initialHistory: [],
        sessionCheckpointDir: null, // No checkpoints for sub-agents
        runRecord: null,
        onCheckpoint: null,
        initialize: async () => ({
          runId: subRunId,
          onEvent: undefined,
          headless: true,
          browserSession: null,
          observeDesktop: false,
        }),
        observe: observeDesktopAgent,
        decide: async ({ task: currentTask, step, history, observation }) =>
          subPlan({
            model: parentModel,
            agentModels: parentAgentModels,
            strategy: parentStrategy,
            onEvent: undefined,
            cancelSignal: parentCancelSignal,
            task: currentTask,
            systemPrompt: subSystemPrompt,
            step,
            history,
            observation,
            conversationHistory: [],
          }),
        authorize: subAuthorize,
        shouldObserve: (lastAction) => {
          if (!lastAction) return false;
          const tool = lastAction.tool || '';
          return tool !== 'fs' && tool !== 'terminal' && tool !== 'ide';
        },
        execute: async (state, action, context) => subRouteAction(state, action, context),
        cleanup: async (state) => {
          if (state.browserSession?.view) {
            await state.browserSession.view.navigate('about:blank').catch(() => {});
          }
        },
      });

      log.info(`[SubAgent] 完成子任务 ${subIndex}: ${result.steps.length} 步`);
      return result;
    };
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
      search: async (_state, action) => executeSearchAction(action),
      vision: async (_state, action) => executeVisionAction(action, { openai_client, visionModel }),
      ide: async (_state, action) => executeIdeAction(action),
      chrome: async (_state, action) => executeChromeAction(action),
      terminal: async (_state, action) => executeTerminalAction(action),
      macos: async (state, action) =>
        executeMacOSAction(action, {
          runId: state.runId,
        }),
      spawn: async (state, action) => {
        // Inject runSubAgent for the spawn handler
        const runSubAgent = createSubAgentRunner(
          state.runId,
          state.model,
          state.agentModels,
          state.strategy,
          state.systemPrompt,
          state.cancelSignal
        );
        return executeSpawnAction(action, { runSubAgent });
      },
    },
    { defaultTool: 'core' }
  );

  async function runDesktopAgent({
    task,
    model,
    models: agentModels,
    strategy = 'progressive',
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
    const plan = createDesktopPlanner({ openai_client, anthropic_client, modelConfig, blacklistedModels, modelTimeoutMs, staggerDelayMs, batchSize });

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
        model,
        agentModels,
        strategy,
        systemPrompt,
        cancelSignal,
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
        // chrome 是浏览器类工具，状态变化必须观察；fs/terminal/ide 多为本地无副作用操作可跳过
        return tool !== 'fs' && tool !== 'terminal' && tool !== 'ide';
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
