import { Router } from 'express';
import { loadMemoryForPrompt } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import type { AgentRouterContext } from './agent-types.ts';
import { persistAgentRunMemory } from './agent-run-memory-persist.ts';
import { createAgentRunSession } from './agent-run-session.ts';
import { createDetachedAgentRunSession } from './agent-run-detached.ts';
import { parseAgentRunRequest, resolveCheckpointSeed } from './agent-run-request.ts';
import { executeAgentRun } from './agent-run-execution.ts';
import { removeSessionCheckpoints } from '../agent/core/checkpoint.ts';

export function createAgentRunStartRouter({
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
  // 并发上限：同时运行的 agent 任务数。浏览器工具仍串行（browser-lock），
  // 但聊天/文件/终端类任务可真并发。默认 3，可用 AGENT_MAX_CONCURRENT 调整。
  const maxConcurrent = Math.max(1, Number(process.env.AGENT_MAX_CONCURRENT || 3));

  router.post('/api/agent', async (req, res) => {
    const parsed = parseAgentRunRequest(req.body, defaultModel);
    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    const { task, model, agentModels, strategy, headless, useMemory, conversationHistory, fromCheckpoint, background } = parsed;

    // fromCheckpoint 是回滚重跑，复用原 runId 恢复已有任务，不计入新增并发，不受上限拦截。
    if (!fromCheckpoint && agentRunStore.countActiveRuns() >= maxConcurrent) {
      return res.status(429).json({
        error: `并发任务已达上限（${maxConcurrent}），请等待部分任务完成或取消后再试`,
        activeRuns: agentRunStore.countActiveRuns(),
      });
    }

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(checkpointDir, fromCheckpoint);

    // 清理已结束 run 的 session snapshots（fromCheckpoint 回滚时保留当前 run 的快照）。
    // 并发模式下必须跳过仍在运行的 run，否则会删掉别的任务正在用的回滚快照。
    if (checkpointDir && !fromCheckpoint) {
      const { listSessionCheckpointRuns } = await import('../agent/core/checkpoint.ts');
      const runs = await listSessionCheckpointRuns(checkpointDir);
      const activeRunIds = new Set(agentRunStore.listActiveRuns().map((run: any) => run.runId));
      for (const rid of runs) {
        if (activeRunIds.has(rid)) continue;
        removeSessionCheckpoints(checkpointDir, rid).catch(() => {});
      }
    }

    const normalizedTask = task.trim();
    const agentHeadless = typeof headless === 'boolean' ? headless : process.env.AGENT_HEADLESS === 'true';
    const startedAt = Date.now();
    // fromCheckpoint 回滚时复用原 runId，保持 trace 连续性
    const existingRunId = fromCheckpoint?.runId;
    const runRecord = agentRunStore.createRun({
      model,
      task: normalizedTask,
    }, startedAt, existingRunId);
    const runId = runRecord.runId;

    let memory = null;
    let systemPrompt = '';
    if (useMemory) {
      const loaded = await loadMemoryForPrompt(memoryDir);
      memory = loaded.memory;
      systemPrompt = loaded.systemPrompt;
    }

    // 前台走 SSE session（绑 res），后台走 detached session（只写 store + trace，不碰 res）。
    // 两者暴露相同的 { sendEvent, getTrackingState, close } 契约，下面的执行逻辑完全共用。
    const session = background
      ? createDetachedAgentRunSession({ model, agentHeadless, normalizedTask, runId, startedAt, agentRunStore, memoryDir })
      : createAgentRunSession({ req, res, model, agentHeadless, normalizedTask, runId, startedAt, agentRunStore, memoryDir });

    // 执行 → 关闭 session → 内存持久化。前台 await、后台 fire-and-forget 共用同一套逻辑。
    const runAndPersist = async () => {
      const result = await executeAgentRun({
        runDesktopAgent,
        task: normalizedTask,
        model,
        models: agentModels,
        strategy,
        systemPrompt,
        headless: agentHeadless,
        runId,
        runRecord,
        session,
        cancelSignal: runRecord.cancelAc.signal,
        conversationHistory,
        useMemory,
        checkpointInitialStep,
        checkpointInitialHistory,
        checkpointDir,
        agentRunStore,
      });
      const { agentResult, finalAnswer, agentError } = result;
      session.close({ finalAnswer, agentError, approvalStore });

      if (memory) {
        (async () => {
          try {
            const { stepModels } = session.getTrackingState();
            await persistAgentRunMemory({
              memory,
              memoryDir,
              normalizedTask,
              finalAnswer,
              agentError,
              agentResult,
              model,
              stepModels,
              modelConfig,
              openai_client,
              anthropic_client,
            });
          } catch (err: any) {
            log.error('Memory save failed:', err.message);
          }
        })();
      }
    };

    if (background) {
      // 提交即返回 runId，Agent 在服务端后台继续跑；进度通过
      // GET /api/agent/:runId/status 查询，或 GET /api/agent/stream/:runId 重连观察。
      res.status(202).json({ runId, status: 'running', startedAt });
      runAndPersist().catch((err: any) => {
        log.error(`[Background] run failed runId=${runId}: ${err?.message || err}`);
      });
      return;
    }

    await runAndPersist();
    return;
  });

  return router;
}
