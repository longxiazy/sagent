/**
 * Server — Sagent 主入口，配置 Express 中间件、路由、Agent 运行器、断点恢复
 * Main entry point — Express middleware, routing, agent runner setup, checkpoint resume
 *
 * 启动流程 / Startup:
 *   1. 加载 .env，并安装 Origin/CORS/API Auth/JSON 等安全中间件
 *   2. 创建 Provider Registry，同步加载可用模型；全部供应商失败则终止启动
 *   3. 初始化日志、WebView data store、结构化配置和项目注册表
 *   4. 创建 run/approval store，并按启动配置一次性选择 Worker 或直跑 runner
 *   5. 挂载截图、Agent、Completions、Suggestions 和前端静态资源路由
 *   6. 开始监听，输出启动信息，再按配置扫描并恢复最后一个 checkpoint
 *
 * 配置 / Configuration:
 *   .env             — API Key、监听地址、认证和本地二进制覆盖
 *   data/config.json — Agent profile/参数、工具、MCP server 和 execution 启动配置
 */

import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRunStore } from './helpers/run-store.ts';
import { createApprovalStore } from './agent/core/approval-store.ts';
import { flushLlmLogs, initLlmLogger } from './agent/core/llm-logger.ts';
import { createDesktopAgentRunner } from './agent/desktop/agent.ts';
import { createSandboxedWorkerAgentRunner, getWorkerCancelDelays } from './agent/worker/runner.ts';
import { DEFAULT_VISION_MODEL } from './agent/tools/vision/execute.ts';
import { DEFAULT_DISTILL_MODEL } from './agent/tools/browser/distill.ts';
import { createClients, deriveProviderName } from './agent/core/ai-client.ts';
import { createProviderRegistry } from './agent/core/providers/registry.ts';
import { initWebViewDataStore } from './agent/tools/browser/webview-session.ts';
import { loadChromeMcpConfig } from './agent/tools/chrome/mcp-client.ts';
import { createAgentRouter } from './routes/agent.ts';
import { createAgentScreenshotsRouter } from './routes/agent-screenshots.ts';
import { createCompletionsRouter } from './routes/completions.ts';
import { createSuggestionsRouter } from './routes/suggestions.ts';
import { createSuggestionStore } from './helpers/suggestion-store.ts';
import { listCheckpoints, clearCheckpoints, removeCheckpoint } from './agent/core/checkpoint.ts';
import { createProjectStore, projectDataDir } from './agent/core/project-store.ts';
import { createBaseEventSender, loadMemoryForPrompt, cleanupAgentRun } from './helpers/run-agent.ts';
import { readTraceEvents } from './helpers/trace-store.ts';
import { padEndW, truncateW } from './agent/core/utils.ts';
import { log } from './helpers/logger.ts';
import { configStore } from './agent/core/config-store.ts';
import { createApiAuth, createCorsOptions, createOriginGuard, loadServerSecurityConfig } from './helpers/security.ts';
import { flushAllPersistenceTasks } from './helpers/persistence-queue.ts';
import { persistRecoveredAgentRunMemory } from './routes/agent-run-memory-persist.ts';
import { warnLegacyConfiguration } from './helpers/config-deprecations.ts';
import { cleanupScreenshots } from './helpers/screenshot-store.ts';
import { withPrivateRun } from './helpers/private-run.ts';
import { removePrivateRunArtifacts } from './helpers/private-run-artifacts.ts';

const securityConfig = loadServerSecurityConfig();
const app = express();
app.use(createOriginGuard(securityConfig));
app.use(cors(createCorsOptions(securityConfig)));
app.use(createApiAuth(securityConfig));
app.use(express.json({ limit: '25mb' }));

const { openai_client, gemini_client } = createClients();
const registry = createProviderRegistry({ openai_client, gemini_client });
// 启动时同步拉取模型列表；全部供应商失败则中止启动并打印原因，不再兜底默认模型。
const modelConfig = await registry.loadModelConfig().catch((err: any) => {
  log.error(`[启动失败] ${err.message}`);
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST_DIR = path.resolve(__dirname, 'client/dist');
const MEMORY_DIR = path.resolve(__dirname, process.env.MEMORY_DIR || 'data');
const CHECKPOINT_DIR = MEMORY_DIR;

initLlmLogger(MEMORY_DIR);
initWebViewDataStore(MEMORY_DIR);
// 配置仓库：读取版本化 data/config.json，并兼容迁移旧 runtime-config.json。
// 必须在 createDesktopAgentRunner 之前 init，且供 runtime.ts/memory.ts 热读取。
await configStore.init(MEMORY_DIR);
warnLegacyConfiguration(configStore);
const executionConfig = configStore.execution();
const AGENT_RESUME = executionConfig.resume;

// 项目注册表：每个项目隔离记忆/trace/checkpoint/uploads 与文件工具根。
// 注册表为空时为「无项目」全局态，行为与引入项目概念前一致。
const projectStore = createProjectStore(MEMORY_DIR);
await projectStore.init();

const VISION_MODEL = (configStore.tools().vision?.model || process.env.VISION_MODEL || DEFAULT_VISION_MODEL).trim();
const DISTILL_MODEL = (process.env.DISTILL_MODEL || DEFAULT_DISTILL_MODEL).trim();
const agentSandboxedWorkers = executionConfig.sandboxedWorkers;
const AGENT_WORKER_SANDBOX = executionConfig.workerSandbox;
const agentRunStore = createAgentRunStore();
const approvalStore = createApprovalStore();
const initialAgentConfig = configStore.get();
const directRunDesktopAgent = createDesktopAgentRunner({
  registry,
  openai_client,
  modelConfig,
  maxSteps: initialAgentConfig.maxSteps,
  defaultHeadless: false,
  observeDesktop: initialAgentConfig.observeDesktop,
  modelTimeoutMs: initialAgentConfig.modelTimeoutSec * 1000,
  staggerDelayMs: initialAgentConfig.staggerDelaySec * 1000,
  batchSize: initialAgentConfig.batchSize,
  runStore: agentRunStore,
  approvalStore,
  checkpointDir: CHECKPOINT_DIR,
  visionModel: VISION_MODEL,
  distillModel: DISTILL_MODEL,
});
// runner 类型与 macOS Sandbox 都在启动时固定；UI 保存 execution 后必须重启，
// 后端才会重新创建 Worker runner 或切回进程内直跑。
const runDesktopAgent = agentSandboxedWorkers
  ? createSandboxedWorkerAgentRunner({
      memoryDir: MEMORY_DIR,
      checkpointDir: CHECKPOINT_DIR,
      modelConfig,
      approvalStore,
      runStore: agentRunStore,
      visionModel: VISION_MODEL,
      distillModel: DISTILL_MODEL,
      sandbox: AGENT_WORKER_SANDBOX,
    }) as any
  : directRunDesktopAgent;

const SCREENSHOT_DIR = path.join(MEMORY_DIR, 'screenshots');
app.use('/screenshots', express.static(SCREENSHOT_DIR));
app.use(createAgentScreenshotsRouter({ screenshotDir: SCREENSHOT_DIR }));

// 截图保留策略:仅在 retention.enabled 时,启动清一次 + 每日清一次(动态读 configStore)。
function runScreenshotRetention() {
  const retention = configStore.tools().screenshots?.retention;
  if (!retention?.enabled) return;
  cleanupScreenshots(SCREENSHOT_DIR, retention)
    .then(({ removedFiles, removedBytes }) => {
      if (removedFiles > 0) {
        log.info(`[Screenshots] 保留策略清理 ${removedFiles} 张，释放 ${(removedBytes / 1024 / 1024).toFixed(1)}MB`);
      }
    })
    .catch(err => log.error('[Screenshots] 清理失败:', err?.message || err));
}
runScreenshotRetention();
const screenshotRetentionTimer = setInterval(runScreenshotRetention, 24 * 60 * 60 * 1000);
screenshotRetentionTimer.unref?.();

app.use(createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir: MEMORY_DIR, checkpointDir: CHECKPOINT_DIR, modelConfig, registry, configStore, projectStore }));
app.use(createCompletionsRouter({ registry, modelConfig }));
app.use(createSuggestionsRouter({ store: createSuggestionStore(path.join(__dirname, 'data')) }));

if (fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'))) {
  app.use(express.static(CLIENT_DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/screenshots/')) return next();
    res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'), err => {
      if (err) next(err);
    });
  });
}

const PORT = process.env.PORT || 3001;
const HOST = securityConfig.host;
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

function envMs(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function defaultShutdownGraceMs() {
  const { terminateAfterMs, killAfterMs } = getWorkerCancelDelays();
  return terminateAfterMs + killAfterMs + 1000;
}

async function resumeFromCheckpoint(cp) {
  const { runId, task, model, headless, privateMode, history, step, maxSteps: _maxSteps, startedAt } = cp;
  const agentPrivateMode = privateMode === true;
  return withPrivateRun(agentPrivateMode, async () => {
  // checkpoint 自带项目落盘目录与项目根；旧 checkpoint（无项目）回退全局 MEMORY_DIR / process.cwd()。
  const dataDir = cp.dataDir || MEMORY_DIR;
  const projectRoot = cp.projectRoot || null;
  if (agentPrivateMode) {
    // 新版本隐私 run 根本不会创建 checkpoint；这里只兼容旧版本或异常残留，
    // 恢复前先删除能按 runId 定位的历史产物，后续仍由隐私上下文禁止新写入。
    await Promise.all([...new Set([dataDir, MEMORY_DIR])]
      .map(dir => removePrivateRunArtifacts(dir, runId)));
  }
  log.info(`[Resume] 恢复运行 run_id=${runId} step=${step} task=${task.slice(0, 60)}…`);

  const sendEventWithTrace = createBaseEventSender(runId, agentRunStore, dataDir, {
    persistTrace: !agentPrivateMode,
  });

  const { systemPrompt } = await loadMemoryForPrompt(dataDir);

  // 旧 checkpoint 可能没有 trace；仅在 trace 缺失时重建历史，避免恢复时重复写入旧步骤。
  const existingTraceEvents = agentPrivateMode ? [] : await readTraceEvents(dataDir, runId);
  if (existingTraceEvents.length === 0) {
    sendEventWithTrace({ type: 'status', status: 'starting', runId, message: '准备启动桌面 Agent' });
    for (const h of history) {
      sendEventWithTrace({ type: 'step', step: h.step, stage: 'action', rationale: h.rationale, action: h.action });
      sendEventWithTrace({ type: 'step', step: h.step, stage: 'result', result: h.result });
    }
  }
  sendEventWithTrace({ type: 'status', status: 'resuming', runId, message: `从断点恢复：从第 ${step + 1} 步继续执行任务「${task.slice(0, 60)}」` });

  try {
    const runRecord = agentRunStore.getRun(runId);
    const result = await runDesktopAgent({
      task,
      model,
      models: cp.agentModels,
      strategy: cp.strategy || 'race',
      systemPrompt,
      headless,
      privateMode: privateMode === true,
      runId,
      runRecord,
      startedAt,
      initialStep: step + 1,
      initialHistory: history,
      conversationHistory: cp.conversationHistory || [],
      memory: cp.memory !== false,
      onEvent: sendEventWithTrace,
      cancelSignal: runRecord?.cancelAc?.signal || new AbortController().signal,
      projectRoot,
      dataDir,
    });
    sendEventWithTrace({ type: 'done', runId, answer: result.answer, steps: result.steps, meta: { elapsed_ms: Date.now() - startedAt, step_count: result.steps.length } });
    if (cp.memory !== false && !agentPrivateMode) {
      try {
        const runRecord = agentRunStore.getRun(runId);
        const persistMemory = () => persistRecoveredAgentRunMemory({
          memoryDir: dataDir,
          task,
          result,
          model,
          registry,
        });
        if (runRecord?.persistence) await runRecord.persistence.enqueue(persistMemory);
        else await persistMemory();
      } catch (err: any) {
        log.warn('[Resume] Memory save failed:', err.message);
      }
    }
  } catch (err: any) {
    log.error(`[Resume] 失败 run_id=${runId}:`, err.message);
    sendEventWithTrace({ type: 'error', runId, error: err.message });
  } finally {
    await cleanupAgentRun(dataDir, runId, agentRunStore);
  }
  });
}

/** 跨「全局 + 各项目」目录收集所有未完成 checkpoint，附带各自所在目录，按 startedAt 升序 */
async function collectAllCheckpoints() {
  const dirs = [MEMORY_DIR, ...projectStore.list().projects.map((p: any) => projectDataDir(MEMORY_DIR, p.projectId))];
  const all: { cp: any; dir: string }[] = [];
  for (const dir of dirs) {
    const cps = await listCheckpoints(dir);
    for (const cp of cps) all.push({ cp, dir });
  }
  all.sort((a, b) => (a.cp.startedAt || 0) - (b.cp.startedAt || 0));
  return all;
}

const httpServer = app.listen(Number(PORT), HOST, async () => {
  const cfg = configStore.get();
  const chromeConfig = loadChromeMcpConfig();
  const W = 56;
  const rowPad = (s, n) => padEndW(truncateW(s, n), n);
  const row = (k, v) => `  │  ${rowPad(k, 28)}${rowPad(String(v), W - 32)}│`;
  const hLine = `  ${'─'.repeat(W + 4)}`;
  const dLine = `  ${'═'.repeat(W + 4)}`;

  console.log(`
  ╔${dLine.slice(2)}╗
  ${row('🚀 Sagent Server', `http://${HOST}:${PORT}`)}
  ╠${dLine.slice(2)}╣
  ${row('Models', modelConfig.map(m => m.id).join(', '))}
  ${row('VISION_MODEL', VISION_MODEL)}
  ${hLine}
  ${row('Max Steps', cfg.maxSteps)}
  ${row('Model Timeout', `${cfg.modelTimeoutSec}s`)}
  ${row('Stagger Delay', `${cfg.staggerDelaySec}s`)}
  ${row('Batch Size', cfg.batchSize)}
  ${hLine}
  ${row('Observe Desktop', cfg.observeDesktop)}
  ${row('AGENT_RESUME', AGENT_RESUME)}
  ${row('AGENT_WORKERS', agentSandboxedWorkers ? (AGENT_WORKER_SANDBOX ? 'sandboxed' : 'plain') : 'disabled')}
  ${row('CHROME_PATH', process.env.AGENT_BROWSER_PATH || 'auto')}
  ${chromeConfig.enabled ? row('CHROME_MCP', `${chromeConfig.transport} @ ${chromeConfig.url || `${chromeConfig.host}:${chromeConfig.port}${chromeConfig.ssePath}`}`) : row('CHROME_MCP', 'disabled')}
  ${hLine}
  ${openai_client ? row('Provider', `${deriveProviderName(process.env.NVIDIA_BASE_URL)} @ ${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}`) : ''}
  ${gemini_client ? row('Provider', 'gemini @ generativelanguage.googleapis.com') : ''}
  ${row('NVIDIA_API_KEY', process.env.NVIDIA_API_KEY ? '✓ configured' : '✗ not set')}
  ${row('GEMINI_API_KEY', process.env.GEMINI_API_KEY ? '✓ configured' : '✗ not set')}
  ╚${dLine.slice(2)}╝
  `);

  if (AGENT_RESUME) {
    const found = await collectAllCheckpoints();
    if (found.length > 0) {
      const { cp } = found[found.length - 1];
      // 模型所属 provider 未配置（缺对应 API key）时跳过恢复
      let providerAvailable = true;
      try {
        providerAvailable = Boolean(registry.resolve(cp.model, modelConfig)?.client);
      } catch {
        providerAvailable = false;
      }
      if (!providerAvailable) {
        console.log(`[Resume] 跳过: ${cp.runId} 所需供应商未配置 API key，清理全部 checkpoint`);
        for (const d of new Set(found.map(f => f.dir))) await clearCheckpoints(d);
      } else if (cp.history?.some(h => h.action?.type === 'finish')) {
        console.log(`[Resume] ${cp.runId} 已完成（含 finish 动作），跳过恢复，清理全部 checkpoint`);
        for (const d of new Set(found.map(f => f.dir))) await clearCheckpoints(d);
      } else {
        console.log(`[Resume] 发现 ${found.length} 个未完成任务，恢复最后一个: ${cp.runId}`);
        const resumeDataDir = cp.dataDir || MEMORY_DIR;
        const existingTraceEvents = cp.privateMode === true
          ? []
          : await readTraceEvents(resumeDataDir, cp.runId);
        const initialEventSeq = existingTraceEvents.reduce(
          (next: number, event: any, index: number) => Number.isFinite(event?.seq)
            ? Math.max(next, Number(event.seq) + 1)
            : Math.max(next, index + 2),
          1,
        );
        agentRunStore.createRun({
          model: cp.model,
          task: cp.task,
          privateMode: cp.privateMode === true,
          projectId: cp.dataDir ? undefined : null,
          dataDir: resumeDataDir,
          projectRoot: cp.projectRoot || null,
        }, cp.startedAt, cp.runId, initialEventSeq);
        resumeFromCheckpoint(cp).catch(err => {
          if (cp.privateMode !== true) {
            log.error(`[Resume] 恢复失败 run_id=${cp.runId}:`, err.message);
          }
        });
        for (const other of found.slice(0, -1)) {
          removeCheckpoint(other.dir, other.cp.runId).catch(() => {});
        }
      }
    }
  } else {
    const remaining = await collectAllCheckpoints();
    if (remaining.length > 0) {
      console.log(`[Resume] AGENT_RESUME=false，清理 ${remaining.length} 个残留 checkpoint`);
      for (const { dir } of remaining) {
        await clearCheckpoints(dir);
      }
    }
  }
});

let shuttingDown = false;
let exiting = false;
async function exitAfterFlush(code: number) {
  if (exiting) return;
  exiting = true;
  await Promise.allSettled([flushAllPersistenceTasks(), flushLlmLogs()]);
  process.exit(code);
}

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  const activeRuns = agentRunStore.getRunningRuns();
  // 关闭流程仍取消全部任务，但日志只展开普通 runId，避免泄露隐私任务标识。
  const visibleActiveRunIds = activeRuns
    .filter((run: any) => run.meta?.privateMode !== true)
    .map((run: any) => run.runId);
  log.warn(`[Shutdown] 收到 ${signal}，关闭 HTTP server，取消 ${activeRuns.length} 个 active run${visibleActiveRunIds.length ? `: ${visibleActiveRunIds.join(', ')}` : ''}`);

  httpServer.close(err => {
    if (err) log.warn(`[Shutdown] HTTP server close failed: ${err.message}`);
  });

  for (const run of activeRuns) {
    agentRunStore.cancelRun(run.runId);
    run.workerControl?.cancel?.();
  }
  approvalStore.rejectAll();

  const graceMs = envMs('AGENT_SERVER_SHUTDOWN_GRACE_MS', defaultShutdownGraceMs());
  const startedAt = Date.now();
  const exitCode = SIGNAL_EXIT_CODES[signal] || 0;
  const interval = setInterval(() => {
    const remainingRuns = agentRunStore.getRunningRuns();
    if (remainingRuns.length === 0) {
      clearInterval(interval);
      log.warn('[Shutdown] active runs 已结束，退出');
      void exitAfterFlush(0);
    }
    if (Date.now() - startedAt >= graceMs) {
      clearInterval(interval);
      log.warn(`[Shutdown] 等待 ${graceMs}ms 后仍有 ${remainingRuns.length} 个 active run，退出进程`);
      void exitAfterFlush(exitCode);
    }
  }, 100);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
