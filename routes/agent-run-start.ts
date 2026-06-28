import { Router } from 'express';
import { loadMemoryForPrompt } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';
import { persistAgentRunMemory } from './agent-run-memory-persist.ts';
import { createAgentRunSession } from './agent-run-session.ts';
import { parseAgentRunRequest, resolveCheckpointSeed } from './agent-run-request.ts';
import { executeAgentRun } from './agent-run-execution.ts';
import { removeSessionCheckpoints } from '../agent/core/checkpoint.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';

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
    const parsed = parseAgentRunRequest(req.body);
    if ('error' in parsed) {
      return res.status(400).json({ error: tReq(req, parsed.error) });
    }
    const { task, model, agentModels, strategy, headless, useMemory, conversationHistory, fromCheckpoint, projectId } = parsed;

    const activeRun = agentRunStore.getActiveRun();
    if (activeRun) {
      return res.status(409).json({ error: tReq(req, 'run.alreadyRunning'), runId: activeRun.runId });
    }

    // 解析本次 run 的落盘目录与文件工具根：命中项目用项目目录，否则回退全局（无项目态）。
    const { projectId: resolvedProjectId, projectRoot, dataDir } = resolveRunPaths(projectStore, projectId, memoryDir);
    const runCheckpointDir = dataDir;

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(runCheckpointDir, fromCheckpoint);

    // 清理上一个 run 的 session snapshots（fromCheckpoint 回滚时保留当前 run 的快照）
    if (runCheckpointDir && !fromCheckpoint) {
      const { listSessionCheckpointRuns } = await import('../agent/core/checkpoint.ts');
      const runs = await listSessionCheckpointRuns(runCheckpointDir);
      for (const rid of runs) {
        removeSessionCheckpoints(runCheckpointDir, rid).catch(() => {});
      }
    }

    const normalizedTask = task.trim();
    const agentHeadless = typeof headless === 'boolean' ? headless : process.env.AGENT_HEADLESS === 'true';
    const startedAt = Date.now();
    // fromCheckpoint 回滚时复用原 runId，保持 trace 连续性
    const existingRunId = fromCheckpoint?.runId;
    const runRecord = agentRunStore.createRun({
      model,
      agentModels,
      task: normalizedTask,
      // 项目信息盖到 run 记录上，供 trace/checkpoint 读取端点定位落盘目录
      projectId: resolvedProjectId,
      dataDir,
      projectRoot,
    }, startedAt, existingRunId);
    const runId = runRecord.runId;
    let finalAnswer: string | null = null;
    let agentError: any = null;
    const session = createAgentRunSession({
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
      agentRunStore,
      projectRoot,
      dataDir,
    });
    const { agentResult, finalAnswer: nextFinalAnswer, agentError: nextAgentError } = result;
    finalAnswer = nextFinalAnswer;
    agentError = nextAgentError;
    session.close({ finalAnswer, agentError, approvalStore });

    if (memory) {
      (async () => {
        try {
          const { stepModels } = session.getTrackingState();
          await persistAgentRunMemory({
            memory,
            memoryDir: dataDir,
            normalizedTask,
            finalAnswer,
            agentError,
            agentResult,
            model,
            stepModels,
            modelConfig,
            registry,
          });
        } catch (err: any) {
          log.error('Memory save failed:', err.message);
        }
      })();
    }
    return;
  });

  return router;
}
