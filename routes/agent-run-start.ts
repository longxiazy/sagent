import { Router } from 'express';
import { loadLatestHealthySnapshot } from '../agent/core/checkpoint.ts';
import { loadMemoryForPrompt, cleanupAgentRun } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';
import type { AgentRouterContext } from './agent-types.ts';
import { persistAgentRunMemory } from './agent-run-memory-persist.ts';
import { createAgentRunSession } from './agent-run-session.ts';

async function resolveCheckpointSeed(checkpointDir: string, fromCheckpoint: any) {
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

  return { checkpointInitialStep, checkpointInitialHistory };
}

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

    const { checkpointInitialStep, checkpointInitialHistory } = await resolveCheckpointSeed(checkpointDir, fromCheckpoint);

    const normalizedTask = task.trim();
    const agentHeadless = typeof headless === 'boolean' ? headless : process.env.AGENT_HEADLESS === 'true';
    const startedAt = Date.now();
    const runRecord = agentRunStore.createRun({
      model,
      task: normalizedTask,
    }, startedAt);
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
    });

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
        onEvent: session.sendEvent,
        cancelSignal: runRecord.cancelAc.signal,
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
        memory: useMemory,
        initialStep: checkpointInitialStep,
        initialHistory: checkpointInitialHistory,
      });

      finalAnswer = agentResult.answer;

      const { completedStepCount, observedStepCount, modelsUsed } = session.getTrackingState();
      session.sendEvent({
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
          const { completedStepCount, observedStepCount } = session.getTrackingState();
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
      session.sendEvent({
        type: 'error',
        runId,
        error: err.message,
        rollbackSuggestion,
      });
    } finally {
      await cleanupAgentRun(checkpointDir, runId, agentRunStore);
    }
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
    return;
  });

  return router;
}
