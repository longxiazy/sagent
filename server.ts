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
import { createClients, loadModelConfig, loadAgentMultiModels, isClaudeModel } from './agent/core/ai-client.ts';
import { createChatRouter } from './routes/chat.ts';
import { createAgentRouter } from './routes/agent.ts';
import { createCompletionsRouter } from './routes/completions.ts';
import { listCheckpoints, clearCheckpoints, removeCheckpoint } from './agent/core/checkpoint.ts';
import { loadMemory, buildMemoryPrompt, saveMemory } from './agent/core/memory.ts';
import { padEndW, truncateW } from './agent/core/utils.ts';
import { log } from './helpers/logger.ts';

const app = express();
app.use(cors());
app.use(express.json());

const { openai_client, anthropic_client } = createClients();
const modelConfig = loadModelConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.resolve(__dirname, process.env.MEMORY_DIR || 'data');
const CHECKPOINT_DIR = MEMORY_DIR;
const AGENT_RESUME = process.env.AGENT_RESUME !== 'false';

initLlmLogger(MEMORY_DIR);

const AGENT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
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
});

const SCREENSHOT_DIR = path.join(MEMORY_DIR, 'screenshots');
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.use(createChatRouter({ openai_client, anthropic_client, modelConfig }));
app.use(createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir: MEMORY_DIR, checkpointDir: CHECKPOINT_DIR, domainRules: runDesktopAgent.domainRules, modelConfig, openai_client, anthropic_client }));
app.use(createCompletionsRouter({ openai_client, anthropic_client, modelConfig }));

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function resumeFromCheckpoint(cp) {
  const { runId, task, model, headless, history, step, maxSteps: _maxSteps, startedAt } = cp;
  log.info(`[Resume] 恢复运行 run_id=${runId} step=${step} task=${task.slice(0, 60)}…`);

  const sendEvent = payload => {
    agentRunStore.addEvent(runId, payload);
    const run = agentRunStore.getRun(runId);
    if (run?._reconnectWriters) {
      for (const writer of run._reconnectWriters) {
        writer(payload);
      }
    }
  };

  // Load memory for system prompt
  let systemPrompt = '';
  try {
    const memory = await loadMemory(MEMORY_DIR);
    const memoryPrompt = buildMemoryPrompt(memory);
    if (memoryPrompt) {
      systemPrompt = memoryPrompt;
    }
  } catch (err) {
    log.warn('Memory load failed on resume:', err.message);
  }

  // Replay historical steps as SSE events so frontend sees all previous steps
  sendEvent({ type: 'status', status: 'starting', runId, message: '准备启动桌面 Agent' });
  for (const h of history) {
    sendEvent({
      type: 'step',
      step: h.step,
      stage: 'action',
      rationale: h.rationale,
      action: h.action,
    });
    sendEvent({
      type: 'step',
      step: h.step,
      stage: 'result',
      result: h.result,
    });
  }
  sendEvent({ type: 'status', status: 'resuming', runId, message: `从断点恢复（已完成 ${history.length} 步）` });

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
      onEvent: sendEvent,
      cancelSignal: new AbortController().signal,
    });
    sendEvent({
      type: 'done',
      runId,
      answer: result.answer,
      steps: result.steps,
      meta: { elapsed_ms: Date.now() - startedAt, step_count: result.steps.length },
    });
    if (cp.memory !== false) {
      try {
        const mem = await loadMemory(MEMORY_DIR);
        await saveMemory(MEMORY_DIR, mem);
      } catch (err) {
        log.warn('[Resume] Memory save failed:', err.message);
      }
    }
  } catch (err) {
    log.error(`[Resume] 失败 run_id=${runId}:`, err.message);
    sendEvent({ type: 'error', runId, error: err.message });
  } finally {
    removeCheckpoint(CHECKPOINT_DIR, runId).catch(() => {});
    agentRunStore.closeRun(runId);
  }
}

app.listen(Number(PORT), HOST, async () => {
  const multiModels = loadAgentMultiModels();
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
  ${hLine}
  ${row('NVIDIA_API_KEY', process.env.NVIDIA_API_KEY ? '✓ configured' : '✗ not set')}
  ${row('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ not set')}
  ╚${dLine.slice(2)}╝
  `);

  if (AGENT_RESUME) {
    const checkpoints = await listCheckpoints(CHECKPOINT_DIR);
    if (checkpoints.length > 0) {
      const cp = checkpoints[checkpoints.length - 1];
      const needsNvidia = !isClaudeModel(cp.model, modelConfig);
      if (needsNvidia && !openai_client) {
        console.log(`[Resume] 跳过: ${cp.runId} 需要 NVIDIA_API_KEY 但未配置，清理 checkpoint`);
        await clearCheckpoints(CHECKPOINT_DIR);
      } else {
        console.log(`[Resume] 发现 ${checkpoints.length} 个未完成任务，恢复最后一个: ${cp.runId}`);
        agentRunStore.createRun({ model: cp.model, task: cp.task }, cp.startedAt, cp.runId);
        resumeFromCheckpoint(cp).catch(err => {
          log.error(`[Resume] 恢复失败 run_id=${cp.runId}:`, err.message);
        });
        for (const other of checkpoints.slice(0, -1)) {
          removeCheckpoint(CHECKPOINT_DIR, other.runId).catch(() => {});
        }
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
