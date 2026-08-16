/**
 * Server — Sagent 主入口，配置 Express 中间件、路由、Agent 运行器
 * Main entry point — Express middleware, routing, agent runner setup
 *
 * 启动流程 / Startup:
 *   1. 加载 .env，并安装 Origin/CORS/API Auth/JSON 等安全中间件
 *   2. 创建 Provider Registry，同步加载可用模型；全部供应商失败则终止启动
 *   3. 初始化日志、WebView data store、结构化配置和项目注册表
 *   4. 创建 run/approval store，并按启动配置一次性选择 Worker 或直跑 runner
 *   5. 挂载截图、Agent、Completions、Suggestions 和前端静态资源路由
 *   6. 开始监听，输出启动信息
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
import { createClients, deriveProviderName } from './agent/core/ai-client.ts';
import { createProviderRegistry } from './agent/core/providers/registry.ts';
import { initWebViewDataStore } from './agent/tools/browser/webview-session.ts';
import { loadChromeMcpConfig } from './agent/tools/chrome/mcp-client.ts';
import { closeAllGenericMcpClients } from './agent/tools/mcp/client.ts';
import { createAgentRouter } from './routes/agent.ts';
import { createAgentScreenshotsRouter } from './routes/agent-screenshots.ts';
import { createCompletionsRouter } from './routes/completions.ts';
import { createSuggestionsRouter } from './routes/suggestions.ts';
import { createSuggestionStore } from './helpers/suggestion-store.ts';
import { createProjectStore, projectDataDir, GLOBAL_SCOPE_ID } from './agent/core/project-store.ts';
import { padEndW, truncateW } from './agent/core/utils.ts';
import { log } from './helpers/logger.ts';
import { configStore } from './agent/core/config-store.ts';
import { createApiAuth, createCorsOptions, createOriginGuard, loadServerSecurityConfig } from './helpers/security.ts';
import { flushAllPersistenceTasks } from './helpers/persistence-queue.ts';
import { warnLegacyConfiguration } from './helpers/config-deprecations.ts';
import { cleanupScreenshots } from './helpers/screenshot-store.ts';

const securityConfig = loadServerSecurityConfig();
const app = express();
app.use(createOriginGuard(securityConfig));
app.use(cors(createCorsOptions(securityConfig)));
app.use(createApiAuth(securityConfig));
app.use(express.json({ limit: '25mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST_DIR = path.resolve(__dirname, 'client/dist');
const MEMORY_DIR = path.resolve(__dirname, process.env.MEMORY_DIR || 'data');
// 无项目 run 数据的全局桶,与真实项目 {MEMORY_DIR}/projects/<id> 同级。
// 也是 Session 回滚快照在无显式 dataDir 时的回退目录。
const GLOBAL_SCOPE_DIR = projectDataDir(MEMORY_DIR, GLOBAL_SCOPE_ID);
const CHECKPOINT_DIR = GLOBAL_SCOPE_DIR;

initLlmLogger(MEMORY_DIR);
initWebViewDataStore(MEMORY_DIR);
// 配置仓库：读取版本化 data/config.json，并兼容迁移旧 runtime-config.json。
// 必须在 loadModelConfig() 之前 init——provider 列模型时要读 models 段来判定
// agentCompatible；也必须在 createDesktopAgentRunner 之前，且供 runtime.ts/memory.ts 热读取。
await configStore.init(MEMORY_DIR);
warnLegacyConfiguration(configStore);
const executionConfig = configStore.execution();

const { openai_client, gemini_client } = createClients();
const registry = createProviderRegistry({ openai_client, gemini_client });
// 启动时同步拉取模型列表；全部供应商失败则中止启动并打印原因，不再兜底默认模型。
const modelConfig = await registry.loadModelConfig().catch((err: any) => {
  log.error(`[启动失败] ${err.message}`);
  process.exit(1);
});

// 项目注册表：每个项目隔离记忆/trace/checkpoint/uploads 与文件工具根。
// 注册表为空时为「无项目」全局态，数据落在 GLOBAL_SCOPE_DIR。
const projectStore = createProjectStore(MEMORY_DIR);
await projectStore.init();

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
  ${row('Vision Model', configStore.tools().vision?.model || process.env.VISION_MODEL || 'auto (selected / main model)')}
  ${hLine}
  ${row('Max Steps', cfg.maxSteps)}
  ${row('Model Timeout', `${cfg.modelTimeoutSec}s`)}
  ${row('Stagger Delay', `${cfg.staggerDelaySec}s`)}
  ${row('Batch Size', cfg.batchSize)}
  ${hLine}
  ${row('Observe Desktop', cfg.observeDesktop)}
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
});

let shuttingDown = false;
let exiting = false;
async function exitAfterFlush(code: number) {
  if (exiting) return;
  exiting = true;
  // 通用 MCP 的 stdio server 是本进程 spawn 的子进程，只有 close() 才会 SIGTERM 它们。
  // 沙箱模式下 worker 退出会连带回收，但 sandboxedWorkers=false 时 agent 就跑在本进程，
  // 不显式关闭会残留子进程。
  await Promise.allSettled([
    flushAllPersistenceTasks(),
    flushLlmLogs(),
    closeAllGenericMcpClients(),
  ]);
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
