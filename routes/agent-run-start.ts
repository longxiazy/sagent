import { Router } from 'express';
import { cleanupAgentRun, loadMemoryForPrompt } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';
import { persistAgentRunMemory } from './agent-run-memory-persist.ts';
import { createAgentRunSession } from './agent-run-session.ts';
import { parseAgentRunRequest, resolveCheckpointSeed } from './agent-run-request.ts';
import { executeAgentRun } from './agent-run-execution.ts';
import { removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { resolveRunPathsForExecution } from '../agent/core/project-store.ts';
import { readTraceEvents } from '../helpers/trace-store.ts';

export function createAgentRunStartRouter({
  runDesktopAgent,
  agentRunStore,
  approvalStore,
  memoryDir,
  checkpointDir,
  modelConfig,
  registry,
  projectStore,
}: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent', async (req, res) => {
    let session: ReturnType<typeof createAgentRunSession> | null = null;
    let runId: string | null = null;
    let runCheckpointDir = checkpointDir;
    try {
      const parsed = parseAgentRunRequest(req.body);
      if ('error' in parsed) {
        return res.status(400).json({ error: tReq(req, parsed.error) });
      }
      const { task, model, agentModels, strategy, headless, useMemory, conversationHistory, fromCheckpoint, projectId } = parsed;

      // 解析本次 run 的落盘目录与文件工具根：命中项目用项目目录，否则回退全局（无项目态）。
      const { projectId: resolvedProjectId, projectRoot, dataDir } = await resolveRunPathsForExecution(projectStore, projectId, memoryDir);
      runCheckpointDir = dataDir;

      const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(runCheckpointDir, fromCheckpoint);

      // 清理上一个 run 的 session snapshots（fromCheckpoint 回滚时保留当前 run 的快照）
      if (runCheckpointDir && !fromCheckpoint) {
        const { listSessionCheckpointRuns } = await import('../agent/core/checkpoint.ts');
        const runs = await listSessionCheckpointRuns(runCheckpointDir);
        await Promise.all(runs.map(rid => removeSessionCheckpoints(runCheckpointDir, rid).catch(() => {})));
      }

      const normalizedTask = task.trim();
      const agentHeadless = typeof headless === 'boolean' ? headless : process.env.AGENT_HEADLESS === 'true';
      const startedAt = Date.now();
      // fromCheckpoint 回滚时复用原 runId，保持 trace 连续性
      const existingRunId = fromCheckpoint?.runId;
      const existingTraceEvents = existingRunId ? await readTraceEvents(dataDir, existingRunId) : [];
      const initialEventSeq = existingTraceEvents.reduce(
        (next, event, index) => Number.isFinite(event?.seq)
          ? Math.max(next, Number(event.seq) + 1)
          : Math.max(next, index + 2),
        1,
      );
      const acquired = agentRunStore.tryCreateRun({
        model,
        agentModels,
        task: normalizedTask,
        // 项目信息盖到 run 记录上，供 trace/checkpoint 读取端点定位落盘目录
        projectId: resolvedProjectId,
        dataDir,
        projectRoot,
      }, startedAt, existingRunId, initialEventSeq);
      if ('activeRun' in acquired) {
        return res.status(409).json({ error: tReq(req, 'run.alreadyRunning'), runId: acquired.activeRun.runId });
      }
      const runRecord = acquired.run;
      runId = runRecord.runId;
      let finalAnswer: string | null = null;
      let agentError: any = null;
      session = createAgentRunSession({
        req,
        res,
        model,
        agentHeadless,
        normalizedTask,
        runId,
        startedAt,
        agentRunStore,
        memoryDir: dataDir,
      });
      agentRunStore.transitionRun(runId, 'running');

      let memory = null;
      let systemPrompt = '';
      if (useMemory) {
        const loaded = await loadMemoryForPrompt(dataDir);
        memory = loaded.memory;
        systemPrompt = loaded.systemPrompt;
      }

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
        checkpointDir: runCheckpointDir,
        projectRoot,
        dataDir,
      });
      const { agentResult, finalAnswer: nextFinalAnswer, agentError: nextAgentError, finalStatus } = result;
      finalAnswer = nextFinalAnswer;
      agentError = nextAgentError;
      if (memory) {
        try {
          await runRecord.persistence?.enqueue(async () => {
            const { stepModels } = session!.getTrackingState();
            await persistAgentRunMemory({
              memory,
              memoryDir: dataDir,
              normalizedTask,
              finalAnswer,
              agentError,
              agentResult,
              model,
              stepModels,
              registry,
            });
          });
        } catch (err: any) {
          log.error('Memory save failed:', err.message);
        }
      }
      await runRecord.persistence?.flush();
      session.close({ finalAnswer, agentError, approvalStore });
      await cleanupAgentRun(runCheckpointDir, runId, agentRunStore, { finalStatus });
      return;
    } catch (err: any) {
      const message = err?.message || String(err);
      log.error('Agent start failed:', message);
      if (session && runId) {
        session.sendEvent({ type: 'error', runId, error: message });
        session.close({ finalAnswer: null, agentError: err, approvalStore });
        const finalStatus = agentRunStore.getRun(runId)?.status === 'cancelling' ? 'cancelled' : 'failed';
        await cleanupAgentRun(runCheckpointDir, runId, agentRunStore, { finalStatus }).catch(() => {});
        return;
      }
      if (runId) {
        const finalStatus = agentRunStore.getRun(runId)?.status === 'cancelling' ? 'cancelled' : 'failed';
        await cleanupAgentRun(runCheckpointDir, runId, agentRunStore, { finalStatus }).catch(() => {});
      }
      if (!res.headersSent) {
        const status = Number(err?.status) || 500;
        return res.status(status).json({ error: message, ...(err?.code ? { code: err.code } : {}) });
      }
      try { res.end(); } catch {}
    }
  });

  return router;
}
