import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createAgentRunStore } from './helpers/run-store.js';
import { createApprovalStore } from './agent/core/approval-store.js';
import { initLlmLogger } from './agent/core/llm-logger.js';
import { createDesktopAgentRunner } from './agent/desktop/agent.js';
import { createClients, loadModelConfig, loadAgentMultiModels, isClaudeModel } from './agent/core/ai-client.js';
import { createChatRouter } from './routes/chat.js';
import { createAgentRouter } from './routes/agent.js';
import { createCompletionsRouter } from './routes/completions.js';
import { listCheckpoints, clearCheckpoints, removeCheckpoint } from './agent/core/checkpoint.js';
import { loadMemory, buildMemoryPrompt } from './agent/core/memory.js';
import { log } from './helpers/logger.js';

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
const CHROME_CANDIDATE_PATHS = [
  process.env.AGENT_BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const agentRunStore = createAgentRunStore();
const approvalStore = createApprovalStore();
const runDesktopAgent = createDesktopAgentRunner({
  openai_client,
  anthropic_client,
  modelConfig,
  chromium,
  maxSteps: AGENT_MAX_STEPS,
  browserCandidatePaths: CHROME_CANDIDATE_PATHS,
  defaultHeadless: process.env.AGENT_HEADLESS === 'true',
  observeDesktop: process.env.AGENT_OBSERVE_DESKTOP === 'true',
  runStore: agentRunStore,
  approvalStore,
  checkpointDir: CHECKPOINT_DIR,
});

const SCREENSHOT_DIR = path.join(MEMORY_DIR, 'screenshots');
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.use(createChatRouter({ openai_client, anthropic_client, modelConfig }));
app.use(createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir: MEMORY_DIR, checkpointDir: CHECKPOINT_DIR, domainRules: runDesktopAgent.domainRules, modelConfig }));
app.use(createCompletionsRouter({ openai_client, anthropic_client, modelConfig }));

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function resumeFromCheckpoint(cp) {
  const { runId, task, model, headless, history, step, maxSteps, startedAt } = cp;
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
      systemPrompt,
      headless,
      runId,
      startedAt,
      initialStep: step + 1,
      initialHistory: history,
      onEvent: sendEvent,
    });
    sendEvent({
      type: 'done',
      runId,
      answer: result.answer,
      steps: result.steps,
      meta: { elapsed_ms: Date.now() - startedAt, step_count: result.steps.length },
    });
  } catch (err) {
    log.error(`[Resume] 失败 run_id=${runId}:`, err.message);
    sendEvent({ type: 'error', runId, error: err.message });
  } finally {
    removeCheckpoint(CHECKPOINT_DIR, runId).catch(() => {});
    agentRunStore.closeRun(runId);
  }
}

app.listen(PORT, HOST, async () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`[Models] ${modelConfig.map(m => m.id).join(', ')}`);
  const multiModels = loadAgentMultiModels();
  if (multiModels.length > 0) {
    console.log(`[MultiModel] Agent 每步并发请求: ${multiModels.join(', ')}`);
  }
  console.log(
    `[Config] AGENT_MAX_STEPS=${AGENT_MAX_STEPS} AGENT_HEADLESS=${process.env.AGENT_HEADLESS} ` +
    `AGENT_OBSERVE_DESKTOP=${process.env.AGENT_OBSERVE_DESKTOP} ` +
    `AGENT_RESUME=${AGENT_RESUME} ` +
    `NVIDIA_API_KEY=${process.env.NVIDIA_API_KEY ? '✓' : '✗'} ` +
    `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'} ` +
    `CHROME_PATH=${process.env.AGENT_BROWSER_PATH || 'auto'}`
  );

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
