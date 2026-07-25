/**
 * Execute one Agent runner invocation and translate its outcome into terminal SSE events.
 * On failure, normal runs attach the latest prior healthy snapshot as a rollback hint;
 * private runs have no checkpointDir and therefore return no rollback suggestion.
 */

import { loadLatestHealthySnapshot } from '../agent/core/checkpoint.ts';
import { log } from '../helpers/logger.ts';
import type {
  AgentStep,
  DesktopAgentResult,
  DesktopAgentRunner,
  RunRecord,
  TerminalRunStatus,
} from '../agent/core/contracts.ts';
import type { AgentRunSession } from './agent-run-session.ts';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function buildRollbackSuggestion({
  checkpointDir,
  runId,
  completedStepCount,
  observedStepCount,
}: {
  checkpointDir: string | null | undefined;
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
      lastResult: typeof lastStep?.result === 'string' ? lastStep.result.slice(0, 200) : null,
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
  privateMode,
  runId,
  runRecord,
  session,
  cancelSignal,
  conversationHistory,
  useMemory,
  checkpointInitialStep,
  checkpointInitialHistory,
  checkpointDir,
  projectRoot,
  dataDir,
}: {
  runDesktopAgent: DesktopAgentRunner;
  task: string;
  model: string;
  models: string[];
  strategy: string;
  systemPrompt: string;
  headless: boolean;
  privateMode: boolean;
  runId: string;
  runRecord: RunRecord;
  session: AgentRunSession;
  cancelSignal: AbortSignal;
  conversationHistory: Array<{ role: string; content: string }> | unknown;
  useMemory: boolean;
  checkpointInitialStep?: number;
  checkpointInitialHistory?: AgentStep[];
  checkpointDir: string | null | undefined;
  projectRoot?: string;
  dataDir?: string;
}) {
  let finalAnswer: string | null = null;
  let agentError: Error | null = null;
  let agentResult: DesktopAgentResult | null = null;
  let finalStatus: TerminalRunStatus = 'completed';

  try {
    // Worker and direct runners share this contract, so route-level terminal handling is identical.
    agentResult = await runDesktopAgent({
      task,
      model,
      models,
      strategy,
      systemPrompt,
      headless,
      privateMode,
      runId,
      runRecord,
      onEvent: session.sendEvent,
      cancelSignal,
      conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
      memory: useMemory,
      initialStep: checkpointInitialStep,
      initialHistory: checkpointInitialHistory,
      projectRoot,
      dataDir,
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
  } catch (value: unknown) {
    const err = asError(value);
    agentError = err;
    finalStatus = err.message === 'Agent 已取消' ? 'cancelled' : 'failed';
    if (!privateMode) log.error('Desktop agent error:', err.message);
    const { completedStepCount, observedStepCount } = session.getTrackingState();
    // Suggest the last completed healthy step before the failing/observed step.
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
  }

  return { agentResult, finalAnswer, agentError, finalStatus };
}
