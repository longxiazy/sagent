import { isFailureResult } from './result-status.js';

// 统一的 trace 指标计算：桌面执行面板(AgentPanel)与移动端 tab(AgentPane)共用，
// 避免两端各算一套导致 token 数对不上。
//
// token 口径（关键）：服务端对同一次决策会发两条带 usage 的事件——
//   1) model_plan 的 success/winner/cancelled（每个候选模型一条，planner.ts）
//   2) step/action（仅胜出者，runtime.ts 里的 decision.usage）
// 二者的 usage 是同一批 token，直接全加会重复计算（单模型≈2×）。
// 因此按 step 聚合，每步优先采用「该步所有 model_plan 决策事件」之和——
// 多模型下这会正确计入落败/取消但已产出结果的候选；只有当某步完全没有带
// usage 的 model_plan 事件时，才回退到该步的 action usage。绝不把 action 与
// 其对应的 model_plan 重复相加。

function eventTokens(usage) {
  if (!usage) return 0;
  return (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
}

function eventTime(event) {
  const candidates = [event?.end_time, event?.timestamp, event?.time, event?.ts];
  for (const value of candidates) {
    if (Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function emptyStep(step) {
  return {
    step,
    firstTime: null,
    lastTime: null,
    observeTime: null,
    actionTime: null,
    resultTime: null,
    explicitDurationMs: 0,
    tokens: 0,
    tool: null,
    hasAction: false,
    hasResult: false,
    failed: false,
  };
}

function actionIsToolCall(action) {
  if (!action || typeof action !== 'object') return false;
  return !['finish', 'ask_user', 'notify_user'].includes(action.type);
}

export function computeTraceMetrics(trace) {
  let lastStep = 0;
  let doneStepCount = null;
  const planByStep = new Map();
  const actionByStep = new Map();
  const steps = new Map();
  const llmCalls = new Set();

  let firstTraceTime = null;
  let lastTraceTime = null;
  let doneElapsedMs = null;

  const getStep = step => {
    if (!steps.has(step)) steps.set(step, emptyStep(step));
    return steps.get(step);
  };

  for (const event of trace) {
    if (event.step != null && event.step > lastStep) lastStep = event.step;
    const ts = eventTime(event);
    if (ts != null) {
      firstTraceTime = firstTraceTime == null ? ts : Math.min(firstTraceTime, ts);
      lastTraceTime = lastTraceTime == null ? ts : Math.max(lastTraceTime, ts);
      if (event.step != null) {
        const step = getStep(event.step);
        step.firstTime = step.firstTime == null ? ts : Math.min(step.firstTime, ts);
        step.lastTime = step.lastTime == null ? ts : Math.max(step.lastTime, ts);
        if (event.type === 'step' && event.stage === 'observe') step.observeTime = ts;
        if (event.type === 'step' && event.stage === 'action') step.actionTime = ts;
        if (event.type === 'step' && event.stage === 'result') step.resultTime = ts;
      }
    }

    if (event.step != null && Number.isFinite(event.duration_ms)) {
      const step = getStep(event.step);
      step.explicitDurationMs += Math.max(0, event.duration_ms);
    }

    const tok = eventTokens(event.usage);
    if (tok > 0) {
      if (event.type === 'model_plan') {
        planByStep.set(event.step, (planByStep.get(event.step) || 0) + tok);
      } else if (event.type === 'step' && event.stage === 'action') {
        actionByStep.set(event.step, (actionByStep.get(event.step) || 0) + tok);
      }
    }
    if (event.type === 'model_plan' && ['success', 'winner', 'cancelled', 'failed'].includes(event.stage)) {
      llmCalls.add(`${event.step ?? ''}:${event.model ?? ''}:${event.stage}`);
    }
    if (event.type === 'step' && event.step != null && event.stage === 'action') {
      const step = getStep(event.step);
      step.tool = event.action?.tool || step.tool || 'core';
      step.hasAction = actionIsToolCall(event.action);
    }
    if (event.type === 'step' && event.step != null && event.stage === 'result') {
      const step = getStep(event.step);
      step.hasResult = true;
      step.failed = isFailureResult(event.result);
    }
    if (event.type === 'done' && Number.isFinite(event.meta?.elapsed_ms)) {
      doneElapsedMs = event.meta.elapsed_ms;
    }
    if (event.type === 'done' && event.meta?.step_count != null) {
      doneStepCount = event.meta.step_count;
    }
  }

  let totalTokens = 0;
  const tokenSteps = new Set([...planByStep.keys(), ...actionByStep.keys()]);
  for (const step of tokenSteps) {
    const tokens = planByStep.has(step) ? planByStep.get(step) : (actionByStep.get(step) || 0);
    totalTokens += tokens;
    if (step != null) getStep(step).tokens = tokens;
  }

  const stepDurations = [...steps.values()]
    .filter(step => step.step != null)
    .sort((a, b) => a.step - b.step)
    .map(step => {
      const durationMs = step.resultTime != null && step.firstTime != null
        ? Math.max(0, step.resultTime - step.firstTime)
        : step.explicitDurationMs || (step.lastTime != null && step.firstTime != null ? Math.max(0, step.lastTime - step.firstTime) : 0);
      const status = step.failed
        ? 'failed'
        : !step.hasResult && step.hasAction
          ? 'running'
          : durationMs >= 10000
            ? 'slow'
            : durationMs >= 3000
              ? 'normal'
              : 'fast';
      return {
        step: step.step,
        durationMs,
        tokens: step.tokens,
        tool: step.tool,
        status,
        hasResult: step.hasResult,
      };
    });

  const completedToolCalls = stepDurations.filter(step => {
    const source = steps.get(step.step);
    return source?.hasAction && source?.hasResult;
  });
  const toolFailures = completedToolCalls.filter(step => step.status === 'failed').length;
  const toolSuccesses = completedToolCalls.length - toolFailures;
  const toolCalls = [...steps.values()].filter(step => step.hasAction).length;
  const avgStepMs = stepDurations.length > 0
    ? Math.round(stepDurations.reduce((sum, step) => sum + step.durationMs, 0) / stepDurations.length)
    : 0;
  const slowestStep = stepDurations.reduce((slowest, step) => (
    !slowest || step.durationMs > slowest.durationMs ? step : slowest
  ), null);
  const totalDurationMs = doneElapsedMs ?? (
    firstTraceTime != null && lastTraceTime != null ? Math.max(0, lastTraceTime - firstTraceTime) : 0
  );

  return {
    lastStep,
    totalTokens,
    stepCount: doneStepCount ?? lastStep,
    llmCalls: llmCalls.size,
    toolCalls,
    completedToolCalls: completedToolCalls.length,
    toolSuccesses,
    toolFailures,
    toolSuccessRate: completedToolCalls.length > 0 ? toolSuccesses / completedToolCalls.length : null,
    avgStepMs,
    totalDurationMs,
    slowestStep,
    stepDurations,
  };
}

export function formatTokenCount(value) {
  return value > 999 ? `${(value / 1000).toFixed(1)}k` : value;
}

export function formatDurationMs(value) {
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
