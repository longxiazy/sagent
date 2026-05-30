import { safeJson, cleanText, displayWidth, padEndW } from '../agent/core/utils.ts';
import { buildAgentMetrics } from '../helpers/agent-logging.ts';
import { log } from '../helpers/logger.ts';

export interface RunTrackingState {
  completedStepCount: number;
  observedStepCount: number;
  modelsUsed: string[];
  modelUsage: Record<string, number>;
  stepModels: Record<number, string>;
}

/**
 * 从 SSE 事件流里累计 step 进度和模型用量。
 * 前台(agent-run-session)和后台(agent-run-detached)两条路共用，
 * 避免计数逻辑分叉导致 status / 结果摘要不一致。
 */
export function createRunTracker() {
  let completedStepCount = 0;
  let observedStepCount = 0;
  const modelsUsed = new Set<string>();
  const modelUsageCounts = new Map<string, number>();
  const stepModels: Record<number, string> = {};

  function track(payload: any) {
    if (payload.type === 'step') {
      observedStepCount = Math.max(observedStepCount, payload.step || 0);
      if (payload.stage === 'result') {
        completedStepCount = Math.max(completedStepCount, payload.step || 0);
      }
    }
    if (payload.type === 'model_plan' && payload.stage === 'winner' && payload.step) {
      stepModels[payload.step] = payload.model;
      if (payload.model) {
        modelUsageCounts.set(payload.model, (modelUsageCounts.get(payload.model) || 0) + 1);
      }
    }
    if (payload.type === 'model_plan' && payload.model && ['winner', 'success', 'thinking'].includes(payload.stage)) {
      modelsUsed.add(payload.model);
    }
  }

  function getTrackingState(): RunTrackingState {
    return {
      completedStepCount,
      observedStepCount,
      modelsUsed: [...modelsUsed],
      modelUsage: Object.fromEntries(modelUsageCounts),
      stepModels,
    };
  }

  return { track, getTrackingState };
}

/**
 * 运行结束后打印结果摘要框（✅/⛔/❌ + 耗时 + 步数 + 模型用量）。
 * 从 trackingState 派生，前台/后台共用。
 */
export function logRunSummaryBox({
  startedAt,
  runId,
  finalAnswer,
  agentError,
  trackingState,
}: {
  startedAt: number;
  runId: string;
  finalAnswer: string | null;
  agentError: any;
  trackingState: RunTrackingState;
}) {
  const { completedStepCount, observedStepCount, modelsUsed, modelUsage } = trackingState;
  const status = agentError
    ? agentError.message === 'Agent 已取消'
      ? 'cancelled'
      : 'error'
    : 'done';
  const metrics = buildAgentMetrics(startedAt, {
    stepCount: Math.max(completedStepCount, observedStepCount),
    status,
  });

  const modelSummaryEntries: [string, number][] = Object.entries(modelUsage);
  for (const m of modelsUsed) {
    if (!(m in modelUsage)) {
      modelSummaryEntries.push([m, 0]);
    }
  }
  const usedModels = modelSummaryEntries
    .sort((a, b) => b[1] - a[1])
    .map(([fullName, count]) => {
      const shortName = fullName.split('/').pop();
      return count > 0 ? `${shortName}×${count}` : `${shortName}`;
    })
    .join(', ');
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
    ...innerLines.map(line => `  ║${padEndW(line, W)}║`),
    `  ╚${bRow.slice(2)}╝`,
  ].join('\n');
  log.info(`\n${box}`);
}
