/**
 * Trace 回放重建 — 把 data/traces/<runId>.jsonl 的事件流还原成可离线评测的 ReplayRun。
 *
 * 纯数据变换：不触网、不读写磁盘，供 scripts/trace-eval.ts 与测试复用。
 * 对旧 trace 宽松容错：坏行跳过、缺字段按 undefined 处理；rollback 重放的
 * 同号步骤以后到的事件为准。
 *
 * 与 runtime 的对应关系（重建必须与 runtime.ts 组装 history 的口径一致，
 * 否则离线重跑 assessResultQuality 会与录制结果偏离）：
 *   - 每个已执行动作：step/observe + step/action + step/result 三类事件按 step 号合并；
 *   - finish 步只有 action 事件、没有 result 事件（runtime.ts 对 finish 跳过 result）；
 *   - 审批被拒的步只有 result(rejected) 事件、没有 action 事件；
 *   - history 条目的 url/title 不落 trace，按 runtime 同样规则从 action/observation 推导。
 */

import type { AgentAction, AgentEvent, AgentStep, JsonObject, ResultQuality } from './contracts.ts';

export interface ReplayParseFailure {
  step?: number;
  model?: string;
  rawOutput: string;
  error: string;
}

export interface ReplayRun {
  runId: string;
  task: string;
  agentModels: string[];
  strategy: string;
  steps: AgentStep[];
  /** run 结束前已 observe 但未执行动作的尾步（如解析失败中断时），用于补一个 prompt 构建点。 */
  pendingObservation: { step: number; observation: JsonObject } | null;
  answer: string;
  recordedQuality: ResultQuality | null;
  endedWith: 'done' | 'error' | 'incomplete';
  parseFailures: ReplayParseFailure[];
}

export interface StepPromptContext {
  task: string;
  step: number;
  history: AgentStep[];
  observation: JsonObject;
}

/** 宽松逐行解析 JSONL，坏行跳过（与 trace-store 读取语义一致）。 */
export function parseTraceLines(raw: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 跳过坏行
    }
  }
  return events;
}

const RAW_OUTPUT_MARKER = '原始输出=';

/** 从 planner 抛错文本（`…; 原始输出=<json 字符串>`）还原模型原文，供解析器语料回归使用。 */
export function extractRawOutputFromError(errorText: unknown): string | null {
  const text = typeof errorText === 'string' ? errorText : '';
  const idx = text.indexOf(RAW_OUTPUT_MARKER);
  if (idx < 0) return null;
  const tail = text.slice(idx + RAW_OUTPUT_MARKER.length).trim();
  if (!tail) return null;
  try {
    const decoded = JSON.parse(tail);
    return typeof decoded === 'string' ? decoded : tail;
  } catch {
    return tail;
  }
}

// 镜像 runtime.ts 的私有 actionTargetUrl / observationText。
function actionTargetUrl(action: any): string | null {
  if (typeof action?.url === 'string' && action.url) return action.url;
  if (typeof action?.arguments?.url === 'string' && action.arguments.url) return action.arguments.url;
  return null;
}

function observationText(observation: unknown, key: 'url' | 'title'): string | undefined {
  if (!observation || typeof observation !== 'object') return undefined;
  const value = (observation as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

interface StepDraft {
  step: number;
  rationale?: string;
  action?: AgentAction;
  result?: unknown;
  resultStatus?: AgentStep['resultStatus'];
  resultError?: string | null;
  observation?: JsonObject;
}

/** 把 JSONL 事件流重建为可评测的 ReplayRun（与 runtime.ts 组装 history 口径一致）。
 *  当前使用：scripts/trace-eval.ts 的离线评估、测试复用。 */
export function reconstructRunFromTrace(events: AgentEvent[]): ReplayRun {
  let runId = '';
  let task = '';
  let agentModels: string[] = [];
  let strategy = '';
  let answer = '';
  let recordedQuality: ResultQuality | null = null;
  let endedWith: ReplayRun['endedWith'] = 'incomplete';
  const parseFailures: ReplayParseFailure[] = [];
  const stepMap = new Map<number, StepDraft>();

  for (const event of events as any[]) {
    if (!event || typeof event !== 'object') continue;
    if (!runId && typeof event.runId === 'string') runId = event.runId;

    switch (event.type) {
      case 'run_meta': {
        if (typeof event.task === 'string' && event.task) task = event.task;
        if (Array.isArray(event.agentModels)) {
          const models = event.agentModels.filter((m: unknown) => typeof m === 'string' && m);
          if (models.length) agentModels = models;
        }
        if (typeof event.strategy === 'string' && event.strategy) strategy = event.strategy;
        break;
      }
      case 'step': {
        const stepNo = Number(event.step);
        if (!Number.isInteger(stepNo) || stepNo <= 0) break;
        const entry = stepMap.get(stepNo) || { step: stepNo };
        if (event.stage === 'observe') {
          entry.observation = event.observation && typeof event.observation === 'object' ? event.observation : {};
        } else if (event.stage === 'action') {
          entry.rationale = typeof event.rationale === 'string' ? event.rationale : '';
          if (event.action && typeof event.action === 'object') entry.action = event.action;
        } else if (event.stage === 'result') {
          entry.result = event.result;
          entry.resultStatus = ['success', 'failed', 'rejected'].includes(event.resultStatus)
            ? event.resultStatus
            : undefined;
          entry.resultError = typeof event.resultError === 'string' ? event.resultError : null;
        }
        stepMap.set(stepNo, entry);
        break;
      }
      case 'model_plan': {
        if (event.stage !== 'failed') break;
        const rawOutput = extractRawOutputFromError(event.error);
        if (rawOutput) {
          parseFailures.push({
            step: Number.isInteger(event.step) ? event.step : undefined,
            model: typeof event.model === 'string' ? event.model : undefined,
            rawOutput,
            error: String(event.error ?? ''),
          });
        }
        break;
      }
      case 'done': {
        endedWith = 'done';
        answer = typeof event.answer === 'string' ? event.answer : '';
        recordedQuality = event.quality && typeof event.quality === 'object' ? event.quality : null;
        break;
      }
      case 'error': {
        endedWith = 'error';
        const rawOutput = extractRawOutputFromError(event.error);
        if (rawOutput) {
          parseFailures.push({ rawOutput, error: String(event.error ?? '') });
        }
        break;
      }
      default:
        break;
    }
  }

  // run 结尾的 error 事件会复读最后一次 model_plan failed 的原文，按原文去重。
  const seenRawOutputs = new Set<string>();
  const dedupedFailures = parseFailures.filter(failure => {
    if (seenRawOutputs.has(failure.rawOutput)) return false;
    seenRawOutputs.add(failure.rawOutput);
    return true;
  });

  const drafts = [...stepMap.values()].sort((a, b) => a.step - b.step);
  const executed = drafts.filter(entry => entry.action !== undefined || entry.result !== undefined);
  const steps: AgentStep[] = executed.map(entry => ({
    step: entry.step,
    rationale: entry.rationale ?? '',
    action: entry.action as AgentAction,
    result: entry.result,
    ...(entry.resultStatus ? { resultStatus: entry.resultStatus } : {}),
    resultError: entry.resultError ?? null,
    url: actionTargetUrl(entry.action) || observationText(entry.observation, 'url'),
    title: observationText(entry.observation, 'title'),
    ...(entry.observation ? { observation: entry.observation } : {}),
  }));

  const executedNos = new Set(executed.map(entry => entry.step));
  const tail = drafts.filter(entry => !executedNos.has(entry.step) && entry.observation).pop();
  const pendingObservation = tail ? { step: tail.step, observation: tail.observation as JsonObject } : null;

  return {
    runId,
    task,
    agentModels,
    strategy,
    steps,
    pendingObservation,
    answer,
    recordedQuality,
    endedWith,
    parseFailures: dedupedFailures,
  };
}

function observationForIndex(run: ReplayRun, index: number): JsonObject {
  // 个别步骤可能没有 observe 事件（runtime 的 shouldObserve 跳过时复用上一次观察），向前回退。
  for (let i = index; i >= 0; i -= 1) {
    const observation = run.steps[i]?.observation;
    if (observation && typeof observation === 'object') return observation;
  }
  return {};
}

/** 还原第 index 个已执行步骤在 decide 时刻的 prompt 上下文。 */
export function buildStepPromptContext(run: ReplayRun, index: number): StepPromptContext {
  const target = run.steps[index];
  if (!target) throw new Error(`步骤索引越界: ${index}（共 ${run.steps.length} 步）`);
  return {
    task: run.task,
    step: target.step,
    history: run.steps.slice(0, index),
    observation: observationForIndex(run, index),
  };
}

/** 列出该 run 全部可用的 prompt 构建点：每个已执行步骤 + 未执行的尾步观察（若有）。 */
export function listPromptContexts(run: ReplayRun): StepPromptContext[] {
  const contexts = run.steps.map((_, index) => buildStepPromptContext(run, index));
  if (run.pendingObservation) {
    contexts.push({
      task: run.task,
      step: run.pendingObservation.step,
      history: run.steps.slice(),
      observation: run.pendingObservation.observation,
    });
  }
  return contexts;
}
