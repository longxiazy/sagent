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

export function createAgentRunStartRouter({
  runDesktopAgent,
  agentRunStore,
  approvalStore,
  memoryDir,
  checkpointDir,
  modelConfig,
  registry,
}: AgentRouterContext) {
  const router = Router();
  const defaultModel = modelConfig?.[0]?.id || 'minimaxai/minimax-m2.7';

  router.post('/api/agent', async (req, res) => {
    const parsed = parseAgentRunRequest(req.body, defaultModel);
    if ('error' in parsed) {
      return res.status(400).json({ error: tReq(req, parsed.error) });
    }
    const { task, model, agentModels, strategy, headless, useMemory, conversationHistory, fromCheckpoint } = parsed;

    const activeRun = agentRunStore.getActiveRun();
    if (activeRun) {
      return res.status(409).json({ error: tReq(req, 'run.alreadyRunning'), runId: activeRun.runId });
    }

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(checkpointDir, fromCheckpoint);

    // 清理上一个 run 的 session snapshots（fromCheckpoint 回滚时保留当前 run 的快照）
    const prevRunId = fromCheckpoint?.runId;
    if (checkpointDir && !fromCheckpoint) {
      const { listSessionCheckpointRuns } = await import('../agent/core/checkpoint.ts');
      const runs = await listSessionCheckpointRuns(checkpointDir);
      for (const rid of runs) {
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
      agentModels,
      task: normalizedTask,
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
      memoryDir,
    });

    let memory = null;
    let systemPrompt = '';
    if (useMemory) {
      const loaded = await loadMemoryForPrompt(memoryDir);
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
      checkpointDir,
      agentRunStore,
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
            memoryDir,
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
