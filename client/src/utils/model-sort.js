const nameOf = model => String(model?.label || model?.id || '');

function finitePositive(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstNumber(values) {
  for (const value of values) {
    const n = finitePositive(value);
    if (n != null) return n;
  }
  return null;
}

function nestedNumber(model, key) {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== 'object') return null;
  return finitePositive(pricing[key]);
}

export function modelUpdatedTime(model) {
  const raw = model?.updated ?? model?.updatedAt ?? model?.releasedAt ?? model?.createdAt ?? model?.created;
  if (raw == null || raw === '') return null;
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0) {
    return direct < 10_000_000_000 ? direct * 1000 : direct;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

export function modelPrice(model) {
  const direct = firstNumber([
    model?.pricePerMillionTokens,
    model?.price_per_million_tokens,
    model?.price,
    model?.cost,
  ]);
  if (direct != null) return direct;

  const input = firstNumber([
    model?.inputPricePerMillionTokens,
    model?.input_price_per_million_tokens,
    model?.inputTokenPrice,
    nestedNumber(model, 'input'),
    nestedNumber(model, 'prompt'),
  ]);
  const output = firstNumber([
    model?.outputPricePerMillionTokens,
    model?.output_price_per_million_tokens,
    model?.outputTokenPrice,
    nestedNumber(model, 'output'),
    nestedNumber(model, 'completion'),
  ]);
  if (input == null && output == null) return null;
  if (input == null) return output;
  if (output == null) return input;
  return (input + output) / 2;
}

export function modelSpeed(model) {
  const throughput = firstNumber([
    model?.tokensPerSecond,
    model?.tokens_per_second,
    model?.throughput,
    model?.speed,
  ]);
  if (throughput != null) return throughput;

  const latency = firstNumber([
    model?.latencyMs,
    model?.latency_ms,
    model?.averageLatencyMs,
    model?.average_latency_ms,
    model?.timeToFirstTokenMs,
    model?.time_to_first_token_ms,
  ]);
  return latency != null && latency > 0 ? 1000 / latency : null;
}

export function modelGreetingScore(model) {
  return firstNumber([
    model?.greetingScore,
    model?.greeting_score,
  ]);
}

function modelGreetingLatency(model) {
  return firstNumber([
    model?.greetingAverageLatencyMs,
    model?.greeting_average_latency_ms,
  ]);
}

function recommendationScore(model) {
  const explicit = firstNumber([
    model?.recommendationScore,
    model?.recommendation_score,
    model?.qualityScore,
    model?.quality_score,
  ]);
  if (explicit != null) return 1000 + explicit;

  const capabilities = [
    ...(Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : []),
    ...(Array.isArray(model?.supported_generation_methods) ? model.supported_generation_methods : []),
    ...(Array.isArray(model?.supportedParameters) ? model.supportedParameters : []),
    ...(Array.isArray(model?.supported_parameters) ? model.supported_parameters : []),
  ].map(value => String(value).toLowerCase());
  const context = firstNumber([
    model?.contextWindow,
    model?.context_length,
    model?.inputTokenLimit,
  ]);

  let score = model?.recommended ? 100 : 0;
  if (model?.agentCompatible !== false) score += 20;
  if (capabilities.some(value => /tool|function/.test(value))) score += 14;
  if (capabilities.some(value => /reason/.test(value))) score += 10;
  if (capabilities.some(value => /json|response_format/.test(value))) score += 6;
  if (context) score += Math.min(12, Math.log2(Math.max(1, context / 8_000)) * 2);
  if (model?.description) score += 2;
  if (modelUpdatedTime(model)) score += 2;
  return score;
}

function compareKnown(a, b, getter, direction) {
  const av = getter(a);
  const bv = getter(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return direction * (av - bv);
}

function compareNames(a, b) {
  return nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function sortModels(models, mode = 'recommended', { favoriteIds = [], recentById = {} } = {}) {
  const favorites = new Set(favoriteIds);
  const originalOrder = new Map(models.map((model, index) => [model?.id, index]));
  return [...models].sort((a, b) => {
    const favoriteDelta = Number(favorites.has(b?.id)) - Number(favorites.has(a?.id));
    if (favoriteDelta) return favoriteDelta;

    let result = 0;
    if (mode === 'recent') {
      result = compareKnown(a, b, model => finitePositive(recentById?.[model?.id]), -1);
    } else if (mode === 'name') {
      result = compareNames(a, b);
    } else if (mode === 'updated') {
      result = compareKnown(a, b, modelUpdatedTime, -1);
    } else if (mode === 'price') {
      result = compareKnown(a, b, modelPrice, 1);
    } else if (mode === 'speed') {
      result = compareKnown(a, b, modelSpeed, -1);
    } else if (mode === 'greeting') {
      result = compareKnown(a, b, modelGreetingScore, -1);
      if (!result) result = compareKnown(a, b, modelGreetingLatency, 1);
    } else {
      result = recommendationScore(b) - recommendationScore(a);
    }
    if (result) return result;

    const recentResult = compareKnown(a, b, model => finitePositive(recentById?.[model?.id]), -1);
    if (recentResult) return recentResult;
    const nameResult = compareNames(a, b);
    if (nameResult) return nameResult;
    return (originalOrder.get(a?.id) ?? 0) - (originalOrder.get(b?.id) ?? 0);
  });
}
