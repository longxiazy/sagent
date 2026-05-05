import { Router } from 'express';
import { safeJson, cleanText, displayWidth, padEndW } from '../agent/core/utils.ts';
import { formatLogTime, buildAgentMetrics, buildSseWriter, logAgentEvent } from '../helpers/agent-logging.ts';
import {
  loadMemory,
  saveMemory,
  extractConversationEntry,
  extractProjectKnowledge,
  compactConversationMemory,
} from '../agent/core/memory.ts';
import { loadLatestHealthySnapshot } from '../agent/core/checkpoint.ts';
import { createBaseEventSender, loadMemoryForPrompt, cleanupAgentRun } from '../helpers/run-agent.ts';
import { summarizeText } from '../agent/core/ai-client.ts';
import { log } from '../helpers/logger.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentRunRouter({
  runDesktopAgent,
  agentRunStore,
  approvalStore,
  memoryDir,
  checkpointDir,
  modelConfig,
  openai_client,
  anthropic_client,
}: AgentRouterContext) {
  const router = Router();
  const defaultModel = modelConfig?.[0]?.id || 'minimaxai/minimax-m2.7';

  router.post('/api/agent', async (req, res) => {
    const {
      task,
      model = defaultModel,
      models: reqModels,
      strategy = 'race',
      headless,
      memory: useMemory = true,
      messages: conversationHistory,
      fromCheckpoint,
    } = req.body ?? {};
    const agentModels = Array.isArray(reqModels) && reqModels.length > 0 ? reqModels : [model];

    if (typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: 'task 不能为空' });
    }

    const activeRun = agentRunStore.getActiveRun();
    if (activeRun) {
      return res.status(409).json({ error: '已有 Agent 在运行中，请等待完成或取消', runId: activeRun.runId });
    }

    let checkpointInitialStep;
    let checkpointInitialHistory;
    if (fromCheckpoint && checkpointDir) {
      const cpRunId = fromCheckpoint.runId;
      const cpStep = fromCheckpoint.step;
      if (typeof cpRunId === 'string' && typeof cpStep === 'number') {
        const snapshot = await loadLatestHealthySnapshot(checkpointDir, cpRunId, cpStep);
        if (snapshot) {
          checkpointInitialStep = snapshot.step + 1;
          checkpointInitialHistory = snapshot.history || [];
        }
      }
    }

    const normalizedTask = task.trim();
    const agentHeadless = typeof headless === 'boolean' ? headless : process.env.AGENT_HEADLESS === 'true';
    const startedAt = Date.now();
    const rawSendEvent = buildSseWriter(res);
    const runRecord = agentRunStore.createRun({
      model,
      task: normalizedTask,
    }, startedAt);
    const runId = runRecord.runId;
    let cancelled = false;
    let completedStepCount = 0;
    let observedStepCount = 0;
    let finalAnswer = null;
    let agentError: any = null;

    req.on('close', () => {
      if (!res.writableEnded) {
        log.debug(`[${formatLogTime()}] POST /api/agent client_disconnected model=${model} run_id=${runId}`);
      }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    log.info(
      `[${formatLogTime()}] POST /api/agent model=${model} headless=${agentHeadless} task=${safeJson(normalizedTask)} ` +
        `run_id=${runId}`
    );

    const modelsUsed = new Set();
    const stepModels: Record<number, string> = {};

    const baseSendEvent = createBaseEventSender(runId, agentRunStore);
    const sendEvent = (payload: any) => {
      if (payload.type === 'step') {
        observedStepCount = Math.max(observedStepCount, payload.step || 0);
        if (payload.stage === 'result') {
          completedStepCount = Math.max(completedStepCount, payload.step || 0);
        }
      }
      if (payload.type === 'model_plan' && payload.stage === 'winner' && payload.step) {
        stepModels[payload.step] = payload.model;
      }
      if (payload.type === 'model_plan' && payload.model && ['winner', 'success', 'thinking'].includes(payload.stage)) {
        modelsUsed.add(payload.model);
      }
      logAgentEvent(payload);
      baseSendEvent(payload);
      if (payload.type === 'model_plan' || payload.type === 'session_checkpoint') {
        log.debug(`[SSE] write type=${payload.type} step=${payload.step} stage=${payload.stage ?? '-'} model=${payload.model ?? '-'} writableEnded=${res.writableEnded} writableFinished=${res.writableFinished}`);
      }
      rawSendEvent(payload);
    };

    sendEvent({
      type: 'status',
      status: 'starting',
      runId,
      message: '准备启动桌面 Agent',
    });
    log.debug(`[SSE] stream started, writableEnded=${res.writableEnded} writableFinished=${res.writableFinished}`);

    let memory = null;
    let systemPrompt = '';
    if (useMemory) {
      const loaded = await loadMemoryForPrompt(memoryDir);
      memory = loaded.memory;
      systemPrompt = loaded.systemPrompt;
    }

    let agentResult = null;
    try {
      agentResult = await runDesktopAgent({
        task: normalizedTask,
        model,
        models: agentModels,
        strategy,
        systemPrompt,
        headless: agentHeadless,
        runId,
        runRecord,
        onEvent: sendEvent,
        cancelSignal: runRecord.cancelAc.signal,
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
        memory: useMemory,
        initialStep: checkpointInitialStep,
        initialHistory: checkpointInitialHistory,
      });

      finalAnswer = agentResult.answer;

      sendEvent({
        type: 'done',
        runId,
        answer: agentResult.answer,
        steps: agentResult.steps,
        meta: {
          elapsed_ms: Date.now() - startedAt,
          step_count: Math.max(completedStepCount, observedStepCount),
          models_used: [...modelsUsed],
        },
      });
    } catch (err: any) {
      agentError = err;
      log.error('Desktop agent error:', err?.message || err);
      let rollbackSuggestion = null;
      if (checkpointDir) {
        try {
          const latestStep = Math.max(completedStepCount, observedStepCount) - 1;
          const snapshot = await loadLatestHealthySnapshot(checkpointDir, runId, latestStep);
          if (snapshot) {
            const lastStep = snapshot.history.length > 0 ? snapshot.history[snapshot.history.length - 1] : null;
            rollbackSuggestion = {
              step: snapshot.step,
              lastAction: lastStep ? { type: lastStep.action?.type, tool: lastStep.action?.tool } : null,
              lastRationale: lastStep?.rationale?.slice(0, 200) || null,
              lastResult: lastStep?.result?.slice(0, 200) || null,
            };
          }
        } catch {
          // ignore snapshot load failure
        }
      }
      sendEvent({
        type: 'error',
        runId,
        error: err.message,
        rollbackSuggestion,
      });
    } finally {
      await cleanupAgentRun(checkpointDir, runId, agentRunStore);
    }
    const status = agentError
      ? cancelled || agentError.message === 'Agent 已取消'
        ? 'cancelled'
        : 'error'
      : 'done';
    const metrics = buildAgentMetrics(startedAt, {
      stepCount: Math.max(completedStepCount, observedStepCount),
      status,
    });

    const usedModels = [...modelsUsed].map((m: any) => (m as string).split('/').pop()).join(',');
    const statusIcon = status === 'done' ? '✅' : status === 'cancelled' ? '⛔' : '❌';
    const elapsedSec = (metrics.elapsed_ms / 1000).toFixed(1);
    const statusLine = `  ${statusIcon} Agent ${status.toUpperCase()}  ${elapsedSec}s  ${metrics.step_count} steps  ${usedModels}`;
    const runLine = `  run: ${runId}`;
    const answerLine = finalAnswer ? `  answer: ${safeJson(cleanText(finalAnswer, 80))}` : '';
    const errorLine = agentError ? `  error: ${safeJson(agentError.message)}` : '';
    const innerLines = [statusLine, runLine, answerLine, errorLine].filter(Boolean);
    const W = Math.max(...innerLines.map(displayWidth)) + 4;
    const bRow = `  ${'═'.repeat(W)}`;
    const box = [
      `  ╔${bRow.slice(2)}╗`,
      ...innerLines.map(l => `  ║${padEndW(l, W)}║`),
      `  ╚${bRow.slice(2)}╝`,
    ].join('\n');
    log.info(`\n${box}`);
    clearInterval(heartbeat);
    approvalStore.rejectAll();
    res.end();

    if (memory) {
      (async () => {
        try {
          const answer = finalAnswer || (agentError ? `失败: ${agentError.message.slice(0, 60)}` : '无结果');
          const steps = agentResult?.steps || [];
          const entry = extractConversationEntry({ task: normalizedTask, result: { answer, steps }, model, stepModels });
          memory.conversation.push(entry);
          extractProjectKnowledge(memory, { task: normalizedTask, result: { answer, steps } });
          const modelCounts: Record<string, number> = {};
          for (const m of Object.values(stepModels)) {
            modelCounts[m as string] = (modelCounts[m as string] || 0) + 1;
          }
          const summaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || modelConfig?.[0]?.id;
          const modelStats = Object.entries(modelCounts).map(([m, c]) => `${m.split('/').pop()}×${c}`).join(', ');
          log.info(`[Memory] 开始压缩记忆 ${memory.conversation.length} 条, 摘要模型: ${summaryModel?.split('/').pop() || '无'} (本轮 ${modelStats || '无竞速'})`);
          const memStart = Date.now();
          await compactConversationMemory(memory, {
            summarizeFn: summaryModel
              ? (text: string) => summarizeText({ text, openai_client, anthropic_client, model: summaryModel })
              : undefined,
          });
          await saveMemory(memoryDir, memory);
          log.info(`[Memory] 压缩完成，保留 ${memory.conversation.length} 条, 耗时 ${Date.now() - memStart}ms, 摘要长度 ${memory.conversationSummary.length}`);
        } catch (err: any) {
          log.error('Memory save failed:', err.message);
        }
      })();
    }
    return;
  });

  router.post('/api/agent/cancel', (req, res) => {
    const { runId } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }
    agentRunStore.cancelRun(runId);
    approvalStore.rejectAll();
    return res.json({ ok: true });
  });

  router.get('/api/agent/active', (_req, res) => {
    const run = agentRunStore.getActiveRun();
    if (!run) {
      return res.json({ active: false });
    }
    return res.json({
      active: true,
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      task: run.meta?.task,
      meta: run.meta,
    });
  });

  router.get('/api/agent/stream/:runId', (req, res) => {
    const { runId } = req.params;
    const run = agentRunStore.getRun(runId);
    if (!run) {
      return res.status(404).json({ error: '运行不存在' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    res.write(`data: ${JSON.stringify({
      type: 'run_meta',
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      task: run.meta?.task,
    })}\n\n`);

    let writer = null;
    if (run.status === 'running' && !run.cancelAc.signal.aborted) {
      writer = (payload: any) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };
      run._reconnectWriters = run._reconnectWriters || [];
      run._reconnectWriters.push(writer);

      req.on('close', () => {
        if (run._reconnectWriters) {
          run._reconnectWriters = run._reconnectWriters.filter((w: any) => w !== writer);
        }
      });
    }

    const replayCount = run.events.length;
    for (let i = 0; i < replayCount; i++) {
      res.write(`data: ${JSON.stringify(run.events[i])}\n\n`);
    }

    if (run.status !== 'running' || run.cancelAc.signal.aborted) {
      res.end();
    }
    return;
  });

  return router;
}
