/**
 * Agent Routes — Express 路由，处理 Agent 的启动、取消、重连、审批、记忆等 API
 * Express routes for agent lifecycle: start, cancel, reconnect, approval, memory
 *
 * 端点 / Endpoints:
 *   POST   /api/agent            — 启动 Agent 任务（SSE 流式响应）
 *   POST   /api/agent/cancel     — 取消正在运行的 Agent
 *   GET    /api/agent/active     — 查询当前活跃的 Agent 运行
 *   GET    /api/agent/stream/:id — 重连到运行中的 Agent（重放历史事件）
 *   POST   /api/agent/approvals  — 审批 Agent 的危险操作
 *   POST   /api/agent/question   — 回答 Agent 的提问
 *   GET    /api/agent/memory     — 获取完整记忆数据（前端面板展示）
 *   POST   /api/agent/compact    — 手动触发记忆压缩
 *   GET    /api/agent/fetch-rules — 获取域名抓取规则
 *   POST   /api/agent/fetch-rules — 添加域名规则
 *   DELETE /api/agent/fetch-rules — 删除域名规则
 *   POST   /api/agent/fetch-rules/reset — 重置为默认规则
 *
 * 关键设计 / Key design:
 *   - 任务完成后记忆异步保存（IIFE 在 res.end() 之后），不阻塞 SSE 响应
 *   - 压缩模型选择本轮成功次数最多的模型（stepModels 统计）
 *   - 支持客户端断线重连（/stream/:runId 重放 + 实时转发）
 *
 * 调用场景 / Callers:
 *   - server.js 启动时: createAgentRouter() 挂载到 Express app
 *
 * TODO / 拆分建议 Refactor suggestions:
 *   - 将记忆相关端点（GET/POST memory, compact）拆到 routes/agent-memory.js
 *   - 将审批相关端点（approvals, question）拆到 routes/agent-approval.js
 *   - 将域名规则端点拆到 routes/agent-fetch-rules.js
 */

import { Router } from 'express';
import { safeJson, cleanText, displayWidth, padEndW } from '../agent/core/utils.js';
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
import {
  listSessionCheckpoints,
} from '../agent/core/session-checkpoint.js';
import { summarizeText } from '../agent/core/ai-client.js';
import { log } from '../helpers/logger.js';

export function createAgentRouter({ runDesktopAgent, agentRunStore, approvalStore, memoryDir, checkpointDir, domainRules, modelConfig, openai_client, anthropic_client }) {
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

    const modelsUsed = new Set();
    const stepModels = {};

    const sendEvent = payload => {
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
        isCancelled: () => runRecord.cancelled,
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
        memory: useMemory,
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

      const usedModels = [...modelsUsed].map(m => m.split('/').pop()).join(',');
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
      agentRunStore.closeRun(runId);
      approvalStore.rejectAll();
      res.end();

      // Async memory save — don't block the response
      if (memory) {
        (async () => {
          try {
            const answer = finalAnswer || (agentError ? `失败: ${agentError.message.slice(0, 60)}` : '无结果');
            const steps = agentResult?.steps || [];
            const entry = extractConversationEntry({ task: normalizedTask, result: { answer, steps }, model, stepModels });
            memory.conversation.push(entry);
            extractProjectKnowledge(memory, { task: normalizedTask, result: { answer, steps } });
            const modelCounts = {};
            for (const m of Object.values(stepModels)) {
              modelCounts[m] = (modelCounts[m] || 0) + 1;
            }
            const summaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || modelConfig?.[0]?.id;
            const modelStats = Object.entries(modelCounts).map(([m, c]) => `${m.split('/').pop()}×${c}`).join(', ');
            log.info(`[Memory] 开始压缩记忆 ${memory.conversation.length} 条, 摘要模型: ${summaryModel?.split('/').pop() || '无'} (本轮 ${modelStats || '无竞速'})`);
            const memStart = Date.now();
            await compactConversationMemory(memory, {
              summarizeFn: summaryModel ? (text) => summarizeText({ text, openai_client, anthropic_client, model: summaryModel }) : undefined,
            });
            await saveMemory(memoryDir, memory);
            log.info(`[Memory] 压缩完成，保留 ${memory.conversation.length} 条, 耗时 ${Date.now() - memStart}ms, 摘要长度 ${memory.conversationSummary.length}`);
          } catch (err) {
            log.error('Memory save failed:', err.message);
          }
        })();
      }
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

    if (typeof response !== 'string') {
      return res.status(400).json({ error: 'response 必须是字符串' });
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

  router.get('/api/agent/memory', async (_req, res) => {
    try {
      const memory = await loadMemory(memoryDir);
      res.json({
        conversationCount: memory?.conversation?.length ?? 0,
        summaryLength: memory?.conversationSummary?.length ?? 0,
        conversation: memory?.conversation ?? [],
        conversationSummary: memory?.conversationSummary ?? '',
        lastCompactedAt: memory?.lastCompactedAt ?? '',
        projectKnowledge: memory?.projectKnowledge ?? { structure: [], paths: {}, preferences: [], learnings: [] },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/agent/compact', async (_req, res) => {
    try {
      const memory = await loadMemory(memoryDir);
      if (memory) {
        const summaryModel = modelConfig?.[0]?.id;
        log.info(`[Memory] 手动压缩 ${memory.conversation.length} 条, 摘要模型: ${summaryModel || '无'}`);
        const memStart = Date.now();
        await compactConversationMemory(memory, {
          summarizeFn: summaryModel ? (text) => summarizeText({ text, openai_client, anthropic_client, model: summaryModel }) : undefined,
        });
        await saveMemory(memoryDir, memory);
        log.info(`[Memory] 手动压缩完成，保留 ${memory.conversation.length} 条, 耗时 ${Date.now() - memStart}ms`);
        res.json({ ok: true, message: '已压缩，保留 ' + memory.conversation.length + ' 条' });
      } else {
        res.json({ ok: false, message: '无记忆数据' });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---- v2: 会话检查点 API ----

  /**
   * GET /api/agent/checkpoints — 列出当前运行的所有会话检查点
   */
  router.get('/api/agent/checkpoints', async (_req, res) => {
    if (!checkpointDir) {
      return res.json({ checkpoints: [] });
    }
    const activeRun = agentRunStore.getActiveRun();
    if (!activeRun) {
      return res.json({ checkpoints: [] });
    }
    try {
      const checkpoints = await listSessionCheckpoints(checkpointDir, activeRun.runId);
      res.json({ runId: activeRun.runId, checkpoints });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/agent/rollback — 回滚到指定步数
   * Body: { targetStep: number }
   * 设置 pendingRollback 标记，runtime 会在下一轮循环中执行回滚
   */
  router.post('/api/agent/rollback', (req, res) => {
    const { targetStep } = req.body ?? {};
    if (typeof targetStep !== 'number' || !Number.isInteger(targetStep) || targetStep < 1) {
      return res.status(400).json({ error: 'targetStep 必须是正整数' });
    }
    const activeRun = agentRunStore.getActiveRun();
    if (!activeRun) {
      return res.status(404).json({ error: '没有活跃的运行' });
    }
    activeRun.pendingRollback = targetStep;
    log.info(`[API] 设置回滚请求: runId=${activeRun.runId} targetStep=${targetStep}`);
    res.json({ ok: true, runId: activeRun.runId, targetStep });
  });

  return router;
}
