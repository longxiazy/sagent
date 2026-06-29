function formatTokenCount(tokens) {
  return String(Math.round(tokens));
}

function riskForRatio(ratio) {
  if (ratio >= 0.8) return 'danger';
  if (ratio >= 0.5) return 'warning';
  return 'ok';
}

export function buildActualContextEstimate(trace = [], estimate = null) {
  if (!estimate || !Array.isArray(trace)) return null;

  const usageEvents = trace.filter(event =>
    event?.type === 'model_plan'
    && ['success', 'winner', 'cancelled'].includes(event.stage)
    && Number(event.usage?.prompt_tokens) > 0
  );
  if (usageEvents.length === 0) return null;

  const firstStep = Math.min(...usageEvents.map(event => Number(event.step)).filter(Number.isFinite));
  if (!Number.isFinite(firstStep)) return null;

  const baseByModel = new Map((estimate.modelEstimates || []).map(item => [item.modelId, item]));
  const actualByModel = new Map();
  for (const event of usageEvents.filter(item => Number(item.step) === firstStep)) {
    const modelId = event.model || estimate.max?.modelId || null;
    const promptTokens = Number(event.usage?.prompt_tokens) || 0;
    const base = baseByModel.get(modelId) || estimate.max || {};
    const windowTokens = base.windowTokens || estimate.max?.windowTokens || 128_000;
    const ratio = windowTokens > 0 ? Math.min(1, promptTokens / windowTokens) : 0;
    actualByModel.set(modelId || 'unknown', {
      ...base,
      modelId,
      usedTokens: promptTokens,
      windowTokens,
      ratio,
      percent: Math.round(ratio * 100),
      risk: riskForRatio(ratio),
    });
  }

  const modelEstimates = [...actualByModel.values()];
  if (modelEstimates.length === 0) return null;

  const max = modelEstimates.reduce((acc, item) => item.ratio > acc.ratio ? item : acc, modelEstimates[0]);
  const averageRatio = modelEstimates.reduce((sum, item) => sum + item.ratio, 0) / modelEstimates.length;
  const averageWindowTokens = Math.round(modelEstimates.reduce((sum, item) => sum + item.windowTokens, 0) / modelEstimates.length);

  return {
    ...estimate,
    source: 'actual_prompt_usage',
    usedTokens: max.usedTokens,
    max,
    average: {
      windowTokens: averageWindowTokens,
      ratio: averageRatio,
      percent: Math.round(averageRatio * 100),
      risk: riskForRatio(averageRatio),
    },
    modelCount: modelEstimates.length,
    modelEstimates,
    promptPreview: max.promptPreview || estimate.promptPreview || null,
    risk: max.risk,
    percent: max.percent,
    ratio: max.ratio,
    usedLabel: formatTokenCount(max.usedTokens),
    maxWindowLabel: formatTokenCount(max.windowTokens),
    averageWindowLabel: formatTokenCount(averageWindowTokens),
    actualStep: firstStep,
  };
}
