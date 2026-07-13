/**
 * Server — Sagent 主入口，配置 Express 中间件、路由、Agent 运行器、断点恢复
 * Main entry point — Express middleware, routing, agent runner setup, checkpoint resume
 *
 * 启动流程 / Startup:
 *   1. 加载 .env 配置
 *   2. 创建 LLM 客户端（NVIDIA / Gemini）
 *   3. 初始化 Agent 运行器、审批存储、记忆目录
 *   4. 挂载路由：agent、completions
 *   5. 检查断点（checkpoint），自动恢复上次未完成的任务
 *   6. 输出图形化启动信息（表格样式）
 *
 * 配置 / Configuration:
 *   .env             — API Key、监听地址、认证和本地二进制覆盖
 *   data/config.json — Agent profile、上下文、工具和 MCP server
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
import { createClients, deriveProviderName } from './agent/core/ai-client.ts';
import { createProviderRegistry } from './agent/core/providers/registry.ts';
import { initWebViewDataStore } from './agent/tools/browser/webview-session.ts';
import { loadIdeMcpConfig } from './agent/tools/ide/mcp-client.ts';
import { loadChromeMcpConfig } from './agent/tools/chrome/mcp-client.ts';
import { createAgentRouter } from './routes/agent.ts';
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
import { warnLegacyConfiguration } from './helpers/config-deprecations.ts';

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

// 项目注册表：每个项目隔离记忆/trace/checkpoint/uploads 与文件工具根。
// 注册表为空时为「无项目」全局态，行为与引入项目概念前一致。
const projectStore = createProjectStore(MEMORY_DIR);
await projectStore.init();

const VISION_MODEL = (configStore.tools().vision?.model || process.env.VISION_MODEL || DEFAULT_VISION_MODEL).trim();
const AGENT_SANDBOXED_WORKERS = executionConfig.sandboxedWorkers;
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
});
const runDesktopAgent = AGENT_SANDBOXED_WORKERS
  ? createSandboxedWorkerAgentRunner({
      memoryDir: MEMORY_DIR,
      checkpointDir: CHECKPOINT_DIR,
      modelConfig,
      approvalStore,
      runStore: agentRunStore,
      visionModel: VISION_MODEL,
      sandbox: AGENT_WORKER_SANDBOX,
    }) as any
  : directRunDesktopAgent;
runDesktopAgent.domainRules = directRunDesktopAgent.domainRules;

const SCREENSHOT_DIR = path.join(MEMORY_DIR, 'screenshots');
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.use(createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir: MEMORY_DIR, checkpointDir: CHECKPOINT_DIR, domainRules: runDesktopAgent.domainRules, modelConfig, registry, configStore, projectStore }));
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

async function collectAllCheckpoints() {
  const dirs = [MEMORY_DIR, ...projectStore.list().projects.map((project: any) => projectDataDir(MEMORY_DIR, project.projectId))];
  const all: Array<{ cp: any; dir: string }> = [];
  for (const dir of dirs) {
    for (const cp of await listCheckpoints(dir)) all.push({ cp, dir });
  }
  return all;
}

const httpServer = app.listen(Number(PORT), HOST, async () => {
  const cfg = configStore.get();
  const ideConfig = loadIdeMcpConfig();
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
  ${row('AGENT_MAX_STEPS', cfg.maxSteps)}
  ${row('AGENT_MODEL_TIMEOUT', `${cfg.modelTimeoutSec}s`)}
  ${row('AGENT_STAGGER_DELAY', `${cfg.staggerDelaySec}s`)}
  ${row('AGENT_BATCH_SIZE', cfg.batchSize)}
  ${hLine}
  ${row('AGENT_OBSERVE_DESKTOP', cfg.observeDesktop)}
  ${row('AGENT_WORKERS', AGENT_SANDBOXED_WORKERS ? (AGENT_WORKER_SANDBOX ? 'sandboxed' : 'plain') : 'disabled')}
  ${row('CHROME_PATH', process.env.AGENT_BROWSER_PATH || 'auto')}
  ${ideConfig.enabled ? row('IDE_MCP', `${ideConfig.transport} @ ${ideConfig.transport === 'stdio' ? ideConfig.command : (ideConfig.url || `${ideConfig.host}:${ideConfig.port}${ideConfig.ssePath}`)}`) : row('IDE_MCP', 'disabled')}
  ${ideConfig.enabled ? row('IDE_PROJECT_PATH', ideConfig.projectPath) : ''}
  ${chromeConfig.enabled ? row('CHROME_MCP', `${chromeConfig.transport} @ ${chromeConfig.url || `${chromeConfig.host}:${chromeConfig.port}${chromeConfig.ssePath}`}`) : row('CHROME_MCP', 'disabled')}
  ${hLine}
  ${openai_client ? row('Provider', `${deriveProviderName(process.env.NVIDIA_BASE_URL)} @ ${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}`) : ''}
  ${gemini_client ? row('Provider', 'gemini @ generativelanguage.googleapis.com') : ''}
  ${row('NVIDIA_API_KEY', process.env.NVIDIA_API_KEY ? '✓ configured' : '✗ not set')}
  ${row('GEMINI_API_KEY', process.env.GEMINI_API_KEY ? '✓ configured' : '✗ not set')}
  ╚${dLine.slice(2)}╝
  `);

  const staleCheckpoints = await collectAllCheckpoints();
  if (staleCheckpoints.length > 0) {
    console.log(`[Checkpoint] 清理 ${staleCheckpoints.length} 个重启前遗留的 checkpoint`);
    for (const dir of new Set(staleCheckpoints.map(item => item.dir))) await clearCheckpoints(dir);
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
  const activeRunIds = activeRuns.map((run: any) => run.runId);
  log.warn(`[Shutdown] 收到 ${signal}，关闭 HTTP server，取消 ${activeRuns.length} 个 active run${activeRunIds.length ? `: ${activeRunIds.join(', ')}` : ''}`);

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
