/**
 * Desktop Agent — 浏览器/桌面/文件/终端多工具协同的 Agent 运行器
 * Desktop Agent runtime — orchestrates browser, filesystem, terminal, and MCP tools
 *
 * 核心流程 / Core loop:
 *   initialize → (observe → decide → authorize → execute) × N → cleanup
 *   由 agent/core/runtime.ts 的 runAgentRuntime() 驱动通用循环；
 *   本文件负责注入桌面 Agent 的状态、规划、审批、工具路由和清理实现。
 *
 * 多模型规划 / Multi-model planning:
 *   createDesktopPlanner() 支持三种策略。策略只决定「怎么调度这批模型」，
 *   不增删模型本身；候选集与顺序由调用方传入（可再经动态模型路由重排）。
 *
 *   - race（UI「竞速」，默认）: 按 batchSize 分批、批间隔 staggerDelaySec 错峰启动，
 *     首个有效结果胜出并取消其余。整批全失败时立即跳过延迟启动下一批——
 *     这条「整批失败即续批」的规则仅 race 有。延迟低、token 省，但结果取决于谁最快。
 *   - vote（UI「汇总」）: 同时启动全部活动模型并等待都结束，再由 multi-model.ts
 *     聚合出多数一致的决策。质量更稳，代价是延迟取决于最慢的模型，且每个模型
 *     都要跑满。例外：任一模型返回 finish 就立即短路收尾，不等其余。
 *   - progressive: 先只跑主模型，4s 内出结果就独占；超时未返回或主模型提前失败，
 *     才唤醒其余模型加入竞速。比 race 更省 token，适合主模型通常够用的场景。
 *     **未接入 UI**——前端只发 race/vote，但 POST /api/agent 的 strategy 字段
 *     不做白名单校验，所以 API 直调可以使用它。
 *
 *   模型超时会在本次 run 内加入黑名单；三种策略共用该黑名单与限流冷却。
 *
 * 观测 / Observation:
 *   observeDesktopAgent() 并行采集已启用的桌面状态和已建立的内置浏览器状态：
 *   - 启用桌面观测时优先使用 macOS 原生 helper，helper 失败时回退 AppleScript
 *     窗口采集；截图统一由 screencapture 完成
 *   - 浏览器通过 Bun.WebView（Windows 为 Edge CDP 适配器）执行页面求值
 *   两类结果会合并为统一 observation，供 planner 决策。
 *
 * 调用场景 / Callers:
 *   - server.ts 与 agent/worker/agent-worker.ts 创建 runDesktopAgent 函数
 *   - routes/agent-run-start.ts 接收 POST /api/agent，agent-run-execution.ts 调用 runner
 *   - server.ts 的 resumeFromCheckpoint() 从断点恢复任务
 *
 * 主要职责边界 / Module boundaries:
 *   - planner/: 模型路由及 race / vote / progressive 调度
 *   - core/multi-model.ts: 多模型结果聚合
 *   - core/prompts.ts: 各 provider 的消息构建
 *   - observer.ts: 桌面与浏览器 observation 采集
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
import { createDesktopPlanner, DEFAULT_MODEL_TIMEOUT_MS } from './planner/index.ts';
import { saveHealthySnapshot } from '../core/checkpoint.ts';
import { log } from '../../helpers/logger.ts';
import { isPrivateRun, withPrivateRun } from '../../helpers/private-run.ts';
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
  // 所有内置浏览器操作共享受管会话：串行执行，并在 WebView 失效时统一恢复。
  const {
    cleanupBrowserSession,
    serializeBrowserOperation,
    withBrowserSessionRecovery,
  } = createSharedBrowserSessionManager();

  // 每次 run 都从 configStore 读取行为参数，前台修改后无需重启即可生效。
  // 因此工厂入参 maxSteps/modelTimeoutMs/staggerDelayMs/batchSize/observeDesktop
  // 目前不参与运行时兜底。
  // visionModel/distillModel 也不在这里直接读取；两个工具在 action 执行时动态解析模型。
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

  // 将 runtime 产生的统一 action 分发到具体工具；审批在路由执行前由 runtime 完成。
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
        // 浏览器动作在共享会话队列中执行；会话失效时由管理器重建后重试一次。
        const result = await withBrowserSessionRecovery(state, state.onEvent, (session, recoveryAttempt) => (
          executeBrowserAction(session.view, action, { signal: state.cancelSignal, recoveryAttempt })
        ), {
          step: context?.step,
          actionType: action.type,
          url: 'url' in action ? action.url : ('urls' in action ? action.urls?.[0] : null),
        });
        // http_fetch 在客户端、模型均可用且正文足够长时进行 task 锚定提炼，并保留来源 URL。
        // 条件不满足时直接保留原文；空输出或提炼失败时 distillFetchContent() 回退原文。
        if (action.type === 'http_fetch' && typeof result === 'string' && openai_client) {
          // Distill 模型四级解析：项目覆盖 → 全局配置 → 环境变量 → 当前主模型。
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
      vision: async (state, action, context) => {
        // Vision 兜底模型按四级解析：项目覆盖 → 全局配置 → 环境变量 → 当前主模型。
        // vision 工具仍会优先选择本次 run 中明确具备图片输入能力的候选模型；
        // 若最终兜底模型不支持多模态，由工具返回实际调用错误。
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
          // question 就是用户对图片的要求本身；模型漏填时回落到任务描述，
          // 而不是让整个 run 因为缺一个可推导的参数直接失败。
          task: context?.task,
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
    // 与 UI 选择器和 POST /api/agent 的默认值保持一致。此处曾默认 progressive，
    // 而调用方总会显式传值，导致这个默认值既不生效又与其它两处不符。
    strategy = 'race',
    systemPrompt = null,
    headless = defaultHeadless,
    privateMode = false,
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
    // 未显式提供候选列表时只使用主模型；黑名单仅在当前 run 内生效。
    agentModels = agentModels || [model];
    // 显式参数与外层 AsyncLocalStorage 任一为 true 都按隐私 run 处理，
    // 防止路由/Worker 的嵌套调用意外把外层隐私标记降级。
    const effectivePrivateMode = privateMode === true || isPrivateRun();
    const { maxSteps, modelTimeoutMs, staggerDelayMs, batchSize, observeDesktop, autoModelRouting } = liveConfig();
    const blacklistedModels = new Set();
    // planner 封装模型自动路由、超时、限流以及三种多模型调度策略。
    const plan = createDesktopPlanner({ registry, modelConfig, blacklistedModels, modelTimeoutMs, staggerDelayMs, batchSize, autoModelRouting });

    // 所有工具动作在执行前统一经过策略审批；ask_user 也复用同一等待机制。
    const authorize = createAgentAuthorizer({
      runId,
      approvalStore,
      onEvent,
      runStore,
    });

    // 本次 run 的 session 回滚快照目录：命中项目用项目目录，否则回退工厂注入的全局目录。
    // 隐私模式不创建 session snapshot，避免任务上下文通过回滚文件留下副本。
    const runCheckpointDir = effectivePrivateMode ? null : (dataDir || checkpointDir);

    // 通用 runtime 只控制循环；下面注入桌面 Agent 各阶段的具体实现。
    return withPrivateRun(effectivePrivateMode, () => runAgentRuntime({
      task,
      maxSteps,
      onEvent,
      cancelSignal,
      initialStep,
      initialHistory,
      // 会话级健康快照与手动回滚都使用本次 run 的隔离落盘目录；隐私模式为 null。
      sessionCheckpointDir: runCheckpointDir,
      runRecord,
      // 存在 run 持久化队列时，健康快照也进入该队列，避免并发写入导致次序错乱。
      saveSessionSnapshot: effectivePrivateMode
        ? undefined
        : checkpointWriter?.saveHealthySnapshot
          ? data => runRecord?.persistence
            ? runRecord.persistence.enqueue(() => checkpointWriter.saveHealthySnapshot(data))
            : checkpointWriter.saveHealthySnapshot(data)
          : runRecord?.persistence
            ? data => runRecord.persistence!.enqueue(() => saveHealthySnapshot(data as any))
            : undefined,
      // initialize 返回的可变 state 会贯穿整个 observe/decide/execute 循环。
      initialize: async () => ({
        runId,
        onEvent,
        headless,
        privateMode: effectivePrivateMode,
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
      // 观察与浏览器执行共用串行队列，避免读取到页面切换过程中的中间状态。
      observe: state => serializeBrowserOperation(() => observeDesktopAgent(state)),
      // runtime 已压缩 history；planner 只负责选择模型并生成下一步 action。
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
        // fs/terminal 的执行结果已直接进入 history，额外桌面/浏览器观察通常没有新信息；
        // 若继续下一步，browser、chrome、search、vision、MCP 和 core 动作后均重新观察环境。
        return tool !== 'fs' && tool !== 'terminal';
      },
      // 工具执行仍通过统一路由，以保持取消信号、事件和审批上下文一致。
      execute: async (state, action, context) => routeAction(state, action, context),
      cleanup: async state => {
        // 普通会话复位后可复用；隐私会话会由管理器关闭并清除一次性 profile。
        await cleanupBrowserSession(state);
      },
    }));
  }

  return runDesktopAgent as DesktopAgentRunner;
}
