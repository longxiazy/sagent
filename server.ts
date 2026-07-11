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
import { runtimeConfig } from './agent/core/runtime-config.ts';
import { createApiAuth, createCorsOptions, createOriginGuard, loadServerSecurityConfig } from './helpers/security.ts';
import { flushAllPersistenceTasks } from './helpers/persistence-queue.ts';
import { persistRecoveredAgentRunMemory } from './routes/agent-run-memory-persist.ts';
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
// 运行时配置层：读取版本化 data/config.json，并兼容迁移旧 runtime-config.json。
// 必须在 createDesktopAgentRunner 之前 init，且供 runtime.ts/memory.ts 热读取。
await runtimeConfig.init(MEMORY_DIR);
warnLegacyConfiguration(runtimeConfig);
const executionConfig = runtimeConfig.execution();
const AGENT_RESUME = executionConfig.resume;

// 项目注册表：每个项目隔离记忆/trace/checkpoint/uploads 与文件工具根。
// 注册表为空时为「无项目」全局态，行为与引入项目概念前一致。
const projectStore = createProjectStore(MEMORY_DIR);
await projectStore.init();

const VISION_MODEL = (runtimeConfig.tools().vision?.model || process.env.VISION_MODEL || DEFAULT_VISION_MODEL).trim();
const AGENT_SANDBOXED_WORKERS = executionConfig.sandboxedWorkers;
const AGENT_WORKER_SANDBOX = executionConfig.workerSandbox;
const agentRunStore = createAgentRunStore();
const approvalStore = createApprovalStore();
const initialAgentConfig = runtimeConfig.get();
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

app.use(createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir: MEMORY_DIR, checkpointDir: CHECKPOINT_DIR, domainRules: runDesktopAgent.domainRules, modelConfig, registry, runtimeConfig, projectStore }));
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
  const { runId, task, model, headless, history, step, maxSteps: _maxSteps, startedAt } = cp;
  // checkpoint 自带项目落盘目录与项目根；旧 checkpoint（无项目）回退全局 MEMORY_DIR / process.cwd()。
  const dataDir = cp.dataDir || MEMORY_DIR;
  const projectRoot = cp.projectRoot || null;
  log.info(`[Resume] 恢复运行 run_id=${runId} step=${step} task=${task.slice(0, 60)}…`);

  const sendEventWithTrace = createBaseEventSender(runId, agentRunStore, dataDir);

  const { systemPrompt } = await loadMemoryForPrompt(dataDir);

  // 旧 checkpoint 可能没有 trace；仅在 trace 缺失时重建历史，避免恢复时重复写入旧步骤。
  const existingTraceEvents = await readTraceEvents(dataDir, runId);
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
    if (cp.memory !== false) {
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
  const cfg = runtimeConfig.get();
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
  ${row('AGENT_MEMORY_MAX_ENTRIES', cfg.memoryMaxEntries)}
  ${hLine}
  ${row('AGENT_OBSERVE_DESKTOP', cfg.observeDesktop)}
  ${row('AGENT_RESUME', AGENT_RESUME)}
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
        const existingTraceEvents = await readTraceEvents(resumeDataDir, cp.runId);
        const initialEventSeq = existingTraceEvents.reduce(
          (next: number, event: any, index: number) => Number.isFinite(event?.seq)
            ? Math.max(next, Number(event.seq) + 1)
            : Math.max(next, index + 2),
          1,
        );
        agentRunStore.createRun({ model: cp.model, task: cp.task, projectId: cp.dataDir ? undefined : null, dataDir: resumeDataDir, projectRoot: cp.projectRoot || null }, cp.startedAt, cp.runId, initialEventSeq);
        resumeFromCheckpoint(cp).catch(err => {
          log.error(`[Resume] 恢复失败 run_id=${cp.runId}:`, err.message);
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
