/**
 * Execute one Agent runner invocation and translate its outcome into terminal SSE events.
 * On failure, normal runs suggest resuming from the step right after the latest healthy
 * snapshot; private runs have no checkpointDir and therefore return no rollback suggestion.
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

/**
 * 失败时给出「从第几步重跑」的建议，供前端一键回滚。
 *
 * 这条链路上有两套步号语义，混用会导致多退或少退一步：
 *   - 快照 session-healthy-N.json 的 N —— 第 N 步「已完成」，history 含 1..N
 *   - 回滚接口 targetStep 的 N        —— 从第 N 步「开始重跑」，加载 N-1 的快照
 * 本函数负责在两者之间转换：找到最后一个健康快照，返回它的下一步。
 *
 * 入参的 completedStepCount / observedStepCount 名为 Count，存的却是已见过的最大
 * 步号（见 agent-run-session 里的 Math.max(..., payload.step)），不要当计数用。
 *
 * 隐私 run 没有 checkpointDir，不落盘也就无从建议，返回 null。
 */
export async function buildRollbackSuggestion({
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
    // 失败步自身不会留下健康快照，所以直接以最大步号为上界回溯，
    // 自然落到它之前最后一个健康步，无需额外减一。
    const latestStep = Math.max(completedStepCount, observedStepCount);
    const snapshot = await loadLatestHealthySnapshot(checkpointDir, runId, latestStep);
    // 首步就失败时没有任何健康快照，此时无步可退，交由前端按重新开始处理。
    if (!snapshot) {
      return null;
    }

    // 展示用的上下文取自快照里的最后一步，即 snapshot.step 本身——它是最后一个
    // 成功的步骤，与前端「（上一步: …）」的措辞对应，不要跟着 step 一起加一。
    const lastStep = snapshot.history.length > 0 ? snapshot.history[snapshot.history.length - 1] : null;
    return {
      // 快照步已经成功，重跑要从它的下一步开始；沿用快照步号会把它再跑一遍，
      // 若该步有写文件、跑命令等副作用还会重复执行。
      step: snapshot.step + 1,
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
    // Suggest resuming from the step after the last healthy snapshot.
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
