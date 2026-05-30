/**
 * Server — Sagent 主入口，配置 Express 中间件、路由、Agent 运行器、断点恢复
 * Main entry point — Express middleware, routing, agent runner setup, checkpoint resume
 *
 * 启动流程 / Startup:
 *   1. 加载 .env 配置
 *   2. 创建 LLM 客户端（NVIDIA / Anthropic）
 *   3. 初始化 Agent 运行器、审批存储、记忆目录
 *   4. 挂载路由：chat、agent、completions
 *   5. 检查断点（checkpoint），自动恢复上次未完成的任务
 *   6. 输出图形化启动信息（表格样式）
 *
 * 配置项 / Configuration (env vars):
 *   PORT, HOST                      — 监听地址
 *   MODELS                          — 可用模型列表（逗号分隔）
 *   AGENT_MULTI_MODELS              — 多模型竞速列表
 *   AGENT_MAX_STEPS                 — 单次任务最大步数
 *   AGENT_MODEL_TIMEOUT             — 单步超时（秒）
 *   AGENT_STAGGER_DELAY             — 竞速错峰延迟（秒）
 *   AGENT_BATCH_SIZE                — 每批并发模型数
 *   AGENT_MEMORY_MAX_ENTRIES        — 记忆压缩阈值
 *   AGENT_HEADLESS                  — 兼容旧配置，WebView 后端会忽略该值
 *   AGENT_OBSERVE_DESKTOP           — 是否观测 macOS 桌面
 *   AGENT_RESUME                    — 是否自动恢复断点
 *   MEMORY_DIR                      — 记忆和截图存储目录
 *   VISION_MODEL                    — image_analyze 工具使用的多模态视觉模型
 *   NVIDIA_API_KEY / ANTHROPIC_API_KEY — LLM API 密钥
 */

import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRunStore } from './helpers/run-store.ts';
import { createApprovalStore } from './agent/core/approval-store.ts';
import { initLlmLogger } from './agent/core/llm-logger.ts';
import { createDesktopAgentRunner } from './agent/desktop/agent.ts';
import { DEFAULT_VISION_MODEL } from './agent/tools/vision/execute.ts';
import { createClients, loadModelConfig, loadAgentMultiModels, isClaudeModel } from './agent/core/ai-client.ts';
import { initWebViewDataStore } from './agent/tools/browser/webview-session.ts';
import { loadIdeMcpConfig } from './agent/tools/ide/mcp-client.ts';
import { loadChromeMcpConfig } from './agent/tools/chrome/mcp-client.ts';
import { createChatRouter } from './routes/chat.ts';
import { createAgentRouter } from './routes/agent.ts';
import { createCompletionsRouter } from './routes/completions.ts';
import { createSuggestionsRouter } from './routes/suggestions.ts';
import { createSuggestionStore } from './helpers/suggestion-store.ts';
import { listCheckpoints, clearCheckpoints, removeCheckpoint } from './agent/core/checkpoint.ts';
import { loadMemory, saveMemory } from './agent/core/memory.ts';
import { createBaseEventSender, loadMemoryForPrompt, cleanupAgentRun } from './helpers/run-agent.ts';
import { padEndW, truncateW } from './agent/core/utils.ts';
import { log } from './helpers/logger.ts';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const { openai_client, anthropic_client } = createClients();
const modelConfig = loadModelConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.resolve(__dirname, process.env.MEMORY_DIR || 'data');
const CHECKPOINT_DIR = MEMORY_DIR;
const AGENT_RESUME = process.env.AGENT_RESUME !== 'false';

initLlmLogger(MEMORY_DIR);
initWebViewDataStore(MEMORY_DIR);

const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
const VISION_MODEL = (process.env.VISION_MODEL || DEFAULT_VISION_MODEL).trim();
const agentRunStore = createAgentRunStore();
const approvalStore = createApprovalStore();
const runDesktopAgent = createDesktopAgentRunner({
  openai_client,
  anthropic_client,
  modelConfig,
  maxSteps: AGENT_MAX_STEPS,
  defaultHeadless: process.env.AGENT_HEADLESS === 'true',
  observeDesktop: process.env.AGENT_OBSERVE_DESKTOP === 'true',
  modelTimeoutMs: Number(process.env.AGENT_MODEL_TIMEOUT || 90) * 1000,
  staggerDelayMs: Number(process.env.AGENT_STAGGER_DELAY || 5) * 1000,
  batchSize: Number(process.env.AGENT_BATCH_SIZE || 1),
  runStore: agentRunStore,
  approvalStore,
  checkpointDir: CHECKPOINT_DIR,
  visionModel: VISION_MODEL,
});

const SCREENSHOT_DIR = path.join(MEMORY_DIR, 'screenshots');
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.use(createChatRouter({ openai_client, anthropic_client, modelConfig }));
app.use(createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir: MEMORY_DIR, checkpointDir: CHECKPOINT_DIR, domainRules: runDesktopAgent.domainRules, modelConfig, openai_client, anthropic_client }));
app.use(createCompletionsRouter({ openai_client, anthropic_client, modelConfig }));
app.use(createSuggestionsRouter({ store: createSuggestionStore(path.join(__dirname, 'data')) }));

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function resumeFromCheckpoint(cp) {
  const { runId, task, model, headless, history, step, maxSteps: _maxSteps, startedAt } = cp;
  log.info(`[Resume] 恢复运行 run_id=${runId} step=${step} task=${task.slice(0, 60)}…`);

  // 回放历史事件不需要写 trace 文件（已经存在），只写内存 run-store 供 SSE 重连用
  const sendEvent = createBaseEventSender(runId, agentRunStore);
  const sendEventWithTrace = createBaseEventSender(runId, agentRunStore, MEMORY_DIR);

  const { systemPrompt } = await loadMemoryForPrompt(MEMORY_DIR);

  // Replay historical steps so frontend sees all previous steps (memory-only, no trace write)
  sendEvent({ type: 'status', status: 'starting', runId, message: '准备启动桌面 Agent' });
  for (const h of history) {
    sendEvent({ type: 'step', step: h.step, stage: 'action', rationale: h.rationale, action: h.action });
    sendEvent({ type: 'step', step: h.step, stage: 'result', result: h.result });
  }
  sendEvent({ type: 'status', status: 'resuming', runId, message: `从断点恢复：从第 ${step + 1} 步继续执行任务「${task.slice(0, 60)}」` });

  try {
    const result = await runDesktopAgent({
      task,
      model,
      models: cp.agentModels,
      strategy: cp.strategy || 'race',
      systemPrompt,
      headless,
      runId,
      runRecord: agentRunStore.getRun(runId),
      startedAt,
      initialStep: step + 1,
      initialHistory: history,
      conversationHistory: cp.conversationHistory || [],
      memory: cp.memory !== false,
      onEvent: sendEventWithTrace,
      cancelSignal: new AbortController().signal,
    });
    sendEventWithTrace({ type: 'done', runId, answer: result.answer, steps: result.steps, meta: { elapsed_ms: Date.now() - startedAt, step_count: result.steps.length } });
    if (cp.memory !== false) {
      try {
        const mem = await loadMemory(MEMORY_DIR);
        await saveMemory(MEMORY_DIR, mem);
      } catch (err: any) {
        log.warn('[Resume] Memory save failed:', err.message);
      }
    }
  } catch (err: any) {
    log.error(`[Resume] 失败 run_id=${runId}:`, err.message);
    sendEventWithTrace({ type: 'error', runId, error: err.message });
  } finally {
    await cleanupAgentRun(CHECKPOINT_DIR, runId, agentRunStore);
  }
}

app.listen(Number(PORT), HOST, async () => {
  const multiModels = loadAgentMultiModels();
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
  ${multiModels.length > 0 ? row('MultiModel', multiModels.join(', ')) : ''}
  ${row('VISION_MODEL', VISION_MODEL)}
  ${hLine}
  ${row('AGENT_MAX_STEPS', AGENT_MAX_STEPS)}
  ${row('AGENT_MODEL_TIMEOUT', `${process.env.AGENT_MODEL_TIMEOUT || 90}s`)}
  ${row('AGENT_STAGGER_DELAY', `${process.env.AGENT_STAGGER_DELAY || 5}s`)}
  ${row('AGENT_BATCH_SIZE', process.env.AGENT_BATCH_SIZE || 1)}
  ${row('AGENT_MEMORY_MAX_ENTRIES', process.env.AGENT_MEMORY_MAX_ENTRIES || 20)}
  ${hLine}
  ${row('AGENT_HEADLESS', process.env.AGENT_HEADLESS || false)}
  ${row('AGENT_OBSERVE_DESKTOP', process.env.AGENT_OBSERVE_DESKTOP || false)}
  ${row('AGENT_RESUME', AGENT_RESUME)}
  ${row('CHROME_PATH', process.env.AGENT_BROWSER_PATH || 'auto')}
  ${ideConfig.enabled ? row('IDE_MCP', `${ideConfig.transport} @ ${ideConfig.transport === 'stdio' ? ideConfig.command : (ideConfig.url || `${ideConfig.host}:${ideConfig.port}${ideConfig.ssePath}`)}`) : row('IDE_MCP', 'disabled')}
  ${ideConfig.enabled ? row('IDE_PROJECT_PATH', ideConfig.projectPath) : ''}
  ${chromeConfig.enabled ? row('CHROME_MCP', `${chromeConfig.transport} @ ${chromeConfig.url || `${chromeConfig.host}:${chromeConfig.port}${chromeConfig.ssePath}`}`) : row('CHROME_MCP', 'disabled')}
  ${hLine}
  ${row('NVIDIA_API_KEY', process.env.NVIDIA_API_KEY ? '✓ configured' : '✗ not set')}
  ${row('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ not set')}
  ╚${dLine.slice(2)}╝
  `);

  if (AGENT_RESUME) {
    const checkpoints = await listCheckpoints(CHECKPOINT_DIR);
    if (checkpoints.length > 0) {
      // 并发模式：checkpoint 已按 runId 隔离，逐个评估并恢复所有未完成任务，
      // 而非只恢复最后一个。各自 fire-and-forget。
      let resumedCount = 0;
      for (const cp of checkpoints) {
        const needsNvidia = !isClaudeModel(cp.model, modelConfig);
        if (needsNvidia && !openai_client) {
          console.log(`[Resume] 跳过: ${cp.runId} 需要 NVIDIA_API_KEY 但未配置，清理 checkpoint`);
          await removeCheckpoint(CHECKPOINT_DIR, cp.runId).catch(() => {});
          continue;
        }
        if (cp.history?.some(h => h.action?.type === 'finish')) {
          console.log(`[Resume] ${cp.runId} 已完成（含 finish 动作），跳过恢复，清理 checkpoint`);
          await removeCheckpoint(CHECKPOINT_DIR, cp.runId).catch(() => {});
          continue;
        }
        agentRunStore.createRun({ model: cp.model, task: cp.task }, cp.startedAt, cp.runId);
        resumeFromCheckpoint(cp).catch(err => {
          log.error(`[Resume] 恢复失败 run_id=${cp.runId}:`, err.message);
        });
        resumedCount++;
      }
      if (resumedCount > 0) {
        console.log(`[Resume] 恢复 ${resumedCount} 个未完成任务`);
      }
    }
  } else {
    const remaining = await listCheckpoints(CHECKPOINT_DIR);
    if (remaining.length > 0) {
      console.log(`[Resume] AGENT_RESUME=false，清理 ${remaining.length} 个残留 checkpoint`);
      await clearCheckpoints(CHECKPOINT_DIR);
    }
  }
});
