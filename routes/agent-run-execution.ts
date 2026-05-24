import { loadLatestHealthySnapshot } from '../agent/core/checkpoint.ts';
import { cleanupAgentRun } from '../helpers/run-agent.ts';
import { log } from '../helpers/logger.ts';

async function buildRollbackSuggestion({
  checkpointDir,
  runId,
  completedStepCount,
  observedStepCount,
}: {
  checkpointDir: string;
  runId: string;
  completedStepCount: number;
  observedStepCount: number;
}) {
  if (!checkpointDir) {
    return null;
  }

  try {
    const latestStep = Math.max(completedStepCount, observedStepCount) - 1;
    const snapshot = await loadLatestHealthySnapshot(checkpointDir, runId, latestStep);
    if (!snapshot) {
      return null;
    }

    const lastStep = snapshot.history.length > 0 ? snapshot.history[snapshot.history.length - 1] : null;
    return {
      step: snapshot.step,
      lastAction: lastStep ? { type: lastStep.action?.type, tool: lastStep.action?.tool } : null,
      lastRationale: lastStep?.rationale?.slice(0, 200) || null,
      lastResult: lastStep?.result?.slice(0, 200) || null,
    };
  } catch {
    return null;
  }
}

export async function executeAgentRun({
  runDesktopAgent,
  task,
  model,
  models,
  strategy,
  systemPrompt,
  headless,
  runId,
  runRecord,
  session,
  cancelSignal,
  conversationHistory,
  useMemory,
  checkpointInitialStep,
  checkpointInitialHistory,
  checkpointDir,
  agentRunStore,
}: {
  runDesktopAgent: any;
  task: string;
  model: string;
  models: string[];
  strategy: string;
  systemPrompt: string;
  headless: boolean;
  runId: string;
  runRecord: any;
  session: any;
  cancelSignal: AbortSignal;
  conversationHistory: any;
  useMemory: boolean;
  checkpointInitialStep: any;
  checkpointInitialHistory: any;
  checkpointDir: string;
  agentRunStore: any;
}) {
  let finalAnswer: string | null = null;
  let agentError: any = null;
  let agentResult = null;

  try {
    agentResult = await runDesktopAgent({
      task,
      model,
      models,
      strategy,
      systemPrompt,
      headless,
      runId,
      runRecord,
      onEvent: session.sendEvent,
      cancelSignal,
      conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
      memory: useMemory,
      initialStep: checkpointInitialStep,
      initialHistory: checkpointInitialHistory,
    });

    finalAnswer = agentResult.answer;
    const { completedStepCount, observedStepCount, modelsUsed, modelUsage } = session.getTrackingState();
    session.sendEvent({
      type: 'done',
      runId,
      answer: agentResult.answer,
      steps: agentResult.steps,
      quality: agentResult.quality,
      meta: {
        elapsed_ms: Date.now() - runRecord.startedAt,
        step_count: Math.max(completedStepCount, observedStepCount),
        models_used: [...modelsUsed],
        model_usage: modelUsage,
        status: agentResult.quality?.status || 'done',
        quality: agentResult.quality,
      },
    });
  } catch (err: any) {
    agentError = err;
    log.error('Desktop agent error:', err?.message || err);
    const { completedStepCount, observedStepCount } = session.getTrackingState();
    const rollbackSuggestion = await buildRollbackSuggestion({
      checkpointDir,
      runId,
      completedStepCount,
      observedStepCount,
    });
    session.sendEvent({
      type: 'error',
      runId,
      error: err.message,
      rollbackSuggestion,
    });
  } finally {
    await cleanupAgentRun(checkpointDir, runId, agentRunStore);
  }

  return { agentResult, finalAnswer, agentError };
}
