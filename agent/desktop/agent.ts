/**
 * Desktop Agent — 浏览器/桌面/文件/终端多工具协同的 Agent 运行器
 * Desktop Agent runtime — orchestrates browser, filesystem, terminal, and MCP tools
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
 *   - 将 message 构建（buildGeminiTaskMessages / buildNvidiaTaskMessages）拆到 agent/core/prompts.js
 *   - 将 observation 采集逻辑拆到 agent/desktop/observer.js
 */

import { createActionRouter } from '../core/router.ts';
import { runAgentRuntime } from '../core/runtime.ts';
import { createAgentAuthorizer } from '../policy/approvals.ts';
import { executeBrowserAction } from '../tools/browser/execute.ts';
import { distillFetchContent } from '../tools/browser/distill.ts';
import { readProjectToolsOverride, resolveToolModel } from '../core/tool-model-resolver.ts';
import { executeFsAction } from '../tools/fs/execute.ts';
import { executeSearchAction } from '../tools/search/execute.ts';
import { executeVisionAction } from '../tools/vision/execute.ts';
import { executeChromeAction } from '../tools/chrome/execute.ts';
import { executeGenericMcpAction } from '../tools/mcp/execute.ts';
import { executeTerminalAction } from '../tools/terminal/run.ts';
import { createSharedBrowserSessionManager } from './browser-session-manager.ts';
import { observeDesktopAgent } from './observer.ts';
import { createDesktopPlanner, DEFAULT_MODEL_TIMEOUT_MS } from './planner.ts';
import { saveCheckpoint, saveHealthySnapshot } from '../core/checkpoint.ts';
import { log } from '../../helpers/logger.ts';
import { configStore } from '../core/config-store.ts';
import type { ProviderRegistry } from '../core/providers/registry.ts';
import type { ModelInfo } from '../core/providers/types.ts';
import type {
  AgentRunStore,
  ApprovalStore,
  DesktopAgentRunOptions,
  DesktopAgentRunner,
} from '../core/contracts.ts';

interface DesktopAgentRunnerConfig {
  registry: ProviderRegistry;
  openai_client: unknown;
  modelConfig: ModelInfo[];
  maxSteps?: number;
  defaultHeadless?: boolean;
  observeDesktop?: boolean;
  runStore?: AgentRunStore | null;
  approvalStore: Pick<ApprovalStore, 'request'>;
  checkpointDir?: string;
  visionModel: string;
  distillModel?: string;
  modelTimeoutMs?: number;
  staggerDelayMs?: number;
  batchSize?: number;
}

export function createDesktopAgentRunner({
  registry,
  openai_client,
  modelConfig,
  maxSteps = 8,
  defaultHeadless = false,
  observeDesktop = false,
  runStore,
  approvalStore,
  checkpointDir,
  visionModel,
  distillModel = '',
  modelTimeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  staggerDelayMs = 0,
  batchSize = 1,
}: DesktopAgentRunnerConfig): DesktopAgentRunner {
  const {
    cleanupBrowserSession,
    serializeBrowserOperation,
    withBrowserSessionRecovery,
  } = createSharedBrowserSessionManager();

  // Agent 行为参数每次 run 实时读取（前台改完无需重启即生效）；
  // 构造参数（maxSteps 等）保留为兜底，运行时优先用 configStore。
  function liveConfig() {
    const c = configStore.get();
    return {
      maxSteps: c.maxSteps,
      modelTimeoutMs: c.modelTimeoutSec * 1000,
      staggerDelayMs: c.staggerDelaySec * 1000,
      batchSize: c.batchSize,
      observeDesktop: c.observeDesktop,
      autoModelRouting: c.autoModelRouting,
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
      browser: async (state, action, context) => {
        const result = await withBrowserSessionRecovery(state, state.onEvent, (session, recoveryAttempt) => (
          executeBrowserAction(session.view, action, { signal: state.cancelSignal, recoveryAttempt })
        ), {
          step: context?.step,
          actionType: action.type,
          url: 'url' in action ? action.url : ('urls' in action ? action.urls?.[0] : null),
        });
        // http_fetch 抓取即提炼:长正文进 history 前用模型以 task 为锚压缩(保留来源 URL),
        // 避免后续每步 prompt 平方级膨胀。model 三层解析:项目→全局→env→主模型(默认回退主模型)。
        if (action.type === 'http_fetch' && typeof result === 'string' && openai_client) {
          const projectTools = await readProjectToolsOverride(state.dataDir);
          const model = resolveToolModel('distill', {
            projectTools,
            globalTools: configStore.tools(),
            envModel: process.env.DISTILL_MODEL,
            mainModel: state.model,
          });
          if (model) {
            return distillFetchContent({
              text: result,
              url: action.url,
              task: context?.task,
              client: openai_client as never,
              model,
              signal: state.cancelSignal,
            });
          }
        }
        return result;
      },
      fs: async (state, action) => executeFsAction(action, { cwd: state.projectRoot, dataDir: state.dataDir, signal: state.cancelSignal }),
      search: async (state, action) => executeSearchAction(action, { signal: state.cancelSignal }),
      vision: async (state, action) => {
        // vision model 三层解析:项目→全局→env→主模型;未设回退主模型(用户已确认接受主模型可能非多模态)。
        const projectTools = await readProjectToolsOverride(state.dataDir);
        const resolvedVisionModel = resolveToolModel('vision', {
          projectTools,
          globalTools: configStore.tools(),
          envModel: process.env.VISION_MODEL,
          mainModel: state.model,
        });
        return executeVisionAction(action, {
          registry,
          openai_client,
          modelConfig,
          visionModel: resolvedVisionModel,
          model: state.model,
          agentModels: state.agentModels,
          signal: state.cancelSignal,
          projectRoot: state.projectRoot,
          dataDir: state.dataDir,
        });
      },
      chrome: async (state, action) => executeChromeAction(action, { signal: state.cancelSignal }),
      mcp: async (state, action, context) => {
        let sequence = 0;
        return executeGenericMcpAction(action, {
          signal: state.cancelSignal,
          cwd: state.projectRoot,
          onOutput: event => state.onEvent?.({
            type: 'mcp_output',
            step: context?.step,
            serverName: 'serverName' in action ? action.serverName : '',
            sequence: sequence++,
            ...event,
          }),
        });
      },
      terminal: async (state, action, context) => executeTerminalAction(action, {
        cwd: state.projectRoot,
        signal: state.cancelSignal,
        onOutput: event => state.onEvent?.({
          type: 'terminal_output',
          step: context?.step,
          ...event,
        }),
      }),
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
    projectRoot = null,
    dataDir = null,
    checkpointWriter = null,
  }: DesktopAgentRunOptions) {
    agentModels = agentModels || [model];
    const { maxSteps, modelTimeoutMs, staggerDelayMs, batchSize, observeDesktop, autoModelRouting } = liveConfig();
    const blacklistedModels = new Set();
    const plan = createDesktopPlanner({ registry, modelConfig, blacklistedModels, modelTimeoutMs, staggerDelayMs, batchSize, autoModelRouting });

    const authorize = createAgentAuthorizer({
      runId,
      approvalStore,
      onEvent,
      runStore,
    });

    // 本次 run 的落盘目录：命中项目用项目目录，否则回退工厂注入的全局 checkpointDir。
    const runCheckpointDir = dataDir || checkpointDir;

    return runAgentRuntime({
      task,
      maxSteps,
      onEvent,
      cancelSignal,
      initialStep,
      initialHistory,
      // v2: 会话级健康检查点支持
      sessionCheckpointDir: runCheckpointDir,
      runRecord,
      onCheckpoint: runCheckpointDir
        ? (history, step) => {
            const checkpoint = {
              runId, task, model, systemPrompt, headless,
              history, step, maxSteps, startedAt,
              agentModels, strategy, conversationHistory, memory,
              projectRoot, dataDir,
            };
            const persist = () => checkpointWriter?.saveCheckpoint
              ? checkpointWriter.saveCheckpoint(checkpoint)
              : saveCheckpoint(runCheckpointDir, checkpoint);
            return runRecord?.persistence ? runRecord.persistence.enqueue(persist) : persist();
          }
        : null,
      saveSessionSnapshot: checkpointWriter?.saveHealthySnapshot
        ? data => runRecord?.persistence
          ? runRecord.persistence.enqueue(() => checkpointWriter.saveHealthySnapshot(data))
          : checkpointWriter.saveHealthySnapshot(data)
        : runRecord?.persistence
          ? data => runRecord.persistence!.enqueue(() => saveHealthySnapshot(data as any))
          : undefined,
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
        projectRoot,
        dataDir,
      }),
      observe: state => serializeBrowserOperation(() => observeDesktopAgent(state)),
      decide: async ({ task: currentTask, step, history, observation, finalOnly }) =>
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
          finalOnly,
          conversationHistory,
        }),
      authorize,
      shouldObserve: (lastAction) => {
        if (!lastAction) return false;
        const tool = lastAction.tool || '';
        // chrome 是浏览器类工具，状态变化必须观察；fs/terminal 多为本地无副作用操作可跳过
        return tool !== 'fs' && tool !== 'terminal';
      },
      execute: async (state, action, context) => routeAction(state, action, context),
      cleanup: async state => {
        await cleanupBrowserSession(state);
      },
    });
  }

  return runDesktopAgent as DesktopAgentRunner;
}
