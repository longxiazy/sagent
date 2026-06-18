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

export function computeTraceMetrics(trace) {
  let lastStep = 0;
  let doneStepCount = null;
  const planByStep = new Map();
  const actionByStep = new Map();

  for (const event of trace) {
    if (event.step != null && event.step > lastStep) lastStep = event.step;
    const tok = eventTokens(event.usage);
    if (tok > 0) {
      if (event.type === 'model_plan') {
        planByStep.set(event.step, (planByStep.get(event.step) || 0) + tok);
      } else if (event.type === 'step' && event.stage === 'action') {
        actionByStep.set(event.step, (actionByStep.get(event.step) || 0) + tok);
      }
    }
    if (event.type === 'done' && event.meta?.step_count != null) {
      doneStepCount = event.meta.step_count;
    }
  }

  let totalTokens = 0;
  const steps = new Set([...planByStep.keys(), ...actionByStep.keys()]);
  for (const step of steps) {
    totalTokens += planByStep.has(step) ? planByStep.get(step) : (actionByStep.get(step) || 0);
  }

  return { lastStep, totalTokens, stepCount: doneStepCount ?? lastStep };
}

export function formatTokenCount(value) {
  return value > 999 ? `${(value / 1000).toFixed(1)}k` : value;
}
