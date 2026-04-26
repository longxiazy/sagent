import { Router } from 'express';
import { safeJson, cleanText } from '../agent/core/utils.js';
import { formatLogTime, buildAgentMetrics, buildSseWriter, logAgentEvent } from '../helpers/agent-logging.js';
import {
  loadMemory,
  saveMemory,
  buildMemoryPrompt,
  extractConversationEntry,
  extractProjectKnowledge,
  compactConversationMemory,
} from '../agent/core/memory.js';
import { removeCheckpoint } from '../agent/core/checkpoint.js';
import { log } from '../helpers/logger.js';

export function createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir, checkpointDir, domainRules, modelConfig }) {
  const router = Router();
  const defaultModel = modelConfig?.[0]?.id || 'minimaxai/minimax-m2.7';

  router.post('/api/agent', async (req, res) => {
    const { task, model = defaultModel, models: reqModels, strategy = 'race', headless, memory: useMemory = true, messages: conversationHistory } = req.body ?? {};
    const agentModels = Array.isArray(reqModels) && reqModels.length > 0 ? reqModels : [model];

    if (typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: 'task 不能为空' });
    }

    // 只允许一个 Agent 同时运行
    const activeRun = agentRunStore.getActiveRun();
    if (activeRun) {
      return res.status(409).json({ error: '已有 Agent 在运行中，请等待完成或取消', runId: activeRun.runId });
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
    let agentError = null;

    req.on('close', () => {
      // Don't cancel the run on disconnect — allow reconnect
      if (!res.writableEnded) {
        log.debug(`[${formatLogTime()}] POST /api/agent client_disconnected model=${model} run_id=${runId}`);
      }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    log.info(
      `[${formatLogTime()}] POST /api/agent model=${model} headless=${agentHeadless} task=${safeJson(normalizedTask)} ` +
        `run_id=${runId}`
    );

    const sendEvent = payload => {
      if (payload.type === 'step') {
        observedStepCount = Math.max(observedStepCount, payload.step || 0);
        if (payload.stage === 'result') {
          completedStepCount = Math.max(completedStepCount, payload.step || 0);
        }
      }
      logAgentEvent(payload);
      agentRunStore.addEvent(runId, payload);
      rawSendEvent(payload);
      // Forward to any reconnected clients
      const run = agentRunStore.getRun(runId);
      if (run?._reconnectWriters) {
        for (const writer of run._reconnectWriters) {
          writer(payload);
        }
      }
    };

    sendEvent({
      type: 'status',
      status: 'starting',
      runId,
      message: '准备启动桌面 Agent',
    });

    // Load memory
    let memory = null;
    let systemPrompt = '';
    if (useMemory) {
      try {
        memory = await loadMemory(memoryDir);
        const memoryPrompt = buildMemoryPrompt(memory);
        if (memoryPrompt) {
          systemPrompt = memoryPrompt;
        }
      } catch (err) {
        log.error('Memory load failed:', err.message);
      }
    }

    try {
      const result = await runDesktopAgent({
        task: normalizedTask,
        model,
        models: agentModels,
        strategy,
        systemPrompt,
        headless: agentHeadless,
        runId,
        onEvent: sendEvent,
        isCancelled: () => runRecord.cancelled,
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
      });

      finalAnswer = result.answer;

      // Save memory after successful run
      if (memory && result.answer) {
        try {
          const entry = extractConversationEntry({ task: normalizedTask, result, model });
          memory.conversation.push(entry);
          extractProjectKnowledge(memory, { task: normalizedTask, result });
          compactConversationMemory(memory);
          await saveMemory(memoryDir, memory);
        } catch (err) {
          log.error('Memory save failed:', err.message);
        }
      }

      sendEvent({
        type: 'done',
        runId,
        answer: result.answer,
        steps: result.steps,
        meta: {
          elapsed_ms: Date.now() - startedAt,
          step_count: Math.max(completedStepCount, observedStepCount),
        },
      });
    } catch (err) {
      agentError = err;
      log.error('Desktop agent error:', err?.message || err);
      sendEvent({
        type: 'error',
        runId,
        error: err.message,
      });
    } finally {
      if (checkpointDir) {
        removeCheckpoint(checkpointDir, runId).catch(() => {});
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

      log.info(
        `[${formatLogTime()}] POST /api/agent ${status} model=${model} headless=${agentHeadless} run_id=${runId} ` +
          `elapsed_ms=${metrics.elapsed_ms} step_count=${metrics.step_count} ` +
          `answer=${finalAnswer ? safeJson(cleanText(finalAnswer, 240)) : 'n/a'} ` +
          `error=${agentError ? safeJson(agentError.message) : 'n/a'}`
      );
      agentRunStore.closeRun(runId);
      approvalStore.rejectAll();
      res.end();
    }
  });

  router.post('/api/agent/approvals', (req, res) => {
    const { runId, approvalId, decision } = req.body ?? {};

    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }

    if (typeof approvalId !== 'string' || !approvalId) {
      return res.status(400).json({ error: 'approvalId 不能为空' });
    }

    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision 必须是 approve 或 reject' });
    }

    try {
      approvalStore.resolve(approvalId, decision);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(404).json({ error: err.message });
    }
  });

  router.post('/api/agent/question', (req, res) => {
    const { runId, approvalId, response } = req.body ?? {};

    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }

    if (typeof approvalId !== 'string' || !approvalId) {
      return res.status(400).json({ error: 'approvalId 不能为空' });
    }

    if (typeof response !== 'string' || !response.trim()) {
      return res.status(400).json({ error: 'response 不能为空' });
    }

    try {
      approvalStore.resolve(approvalId, response.trim());
      return res.json({ ok: true });
    } catch (err) {
      return res.status(404).json({ error: err.message });
    }
  });

  // Cancel a running agent
  router.post('/api/agent/cancel', (req, res) => {
    const { runId } = req.body ?? {};
    if (typeof runId !== 'string' || !runId) {
      return res.status(400).json({ error: 'runId 不能为空' });
    }
    agentRunStore.cancelRun(runId);
    approvalStore.rejectAll();
    return res.json({ ok: true });
  });

  // Check for active run (for reconnect after page refresh)
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

  // Reconnect to a running agent — replay stored events
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

    // Send run metadata first so frontend can restore timer and model
    res.write(`data: ${JSON.stringify({
      type: 'run_meta',
      runId: run.runId,
      startedAt: run.startedAt,
      model: run.meta?.model,
      task: run.meta?.task,
    })}\n\n `);

    // Register writer BEFORE snapshotting to avoid event gap
    let writer = null;
    if (run.status === 'running' && !run.cancelled) {
      writer = payload => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };
      run._reconnectWriters = run._reconnectWriters || [];
      run._reconnectWriters.push(writer);

      req.on('close', () => {
        if (run._reconnectWriters) {
          run._reconnectWriters = run._reconnectWriters.filter(w => w !== writer);
        }
      });
    }

    // Snapshot AFTER writer registration — events added between will be forwarded live
    const replayCount = run.events.length;
    for (let i = 0; i < replayCount; i++) {
      res.write(`data: ${JSON.stringify(run.events[i])}\n\n`);
    }

    if (run.status !== 'running' || run.cancelled) {
      res.end();
    }
  });

  // Domain rules management
  router.get('/api/agent/fetch-rules', async (_req, res) => {
    if (!domainRules) {
      return res.json({ domains: [] });
    }
    const domains = await domainRules.getRules();
    res.json({ domains });
  });

  router.post('/api/agent/fetch-rules', async (req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: 'Domain rules 未启用' });
    }
    const { domain } = req.body ?? {};
    if (typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'domain 不能为空' });
    }
    await domainRules.addDomain(domain.trim());
    res.json({ ok: true });
  });

  router.delete('/api/agent/fetch-rules', async (req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: 'Domain rules 未启用' });
    }
    const { domain } = req.body ?? {};
    if (typeof domain !== 'string' || !domain.trim()) {
      return res.status(400).json({ error: 'domain 不能为空' });
    }
    await domainRules.removeDomain(domain.trim());
    res.json({ ok: true });
  });

  router.post('/api/agent/fetch-rules/reset', async (_req, res) => {
    if (!domainRules) {
      return res.status(400).json({ error: 'Domain rules 未启用' });
    }
    await domainRules.resetToDefaults();
    res.json({ ok: true });
  });

  return router;
}
