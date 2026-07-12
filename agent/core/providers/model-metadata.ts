import type { ModelInfo } from './types.ts';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n) return n;
  }
  return undefined;
}

function firstNonNegativeNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    const n = finiteNonNegativeNumber(value);
    if (n != null) return n;
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))];
  return items.length ? items : undefined;
}

function firstStringArray(values: unknown[]): string[] | undefined {
  for (const value of values) {
    const items = stringArray(value);
    if (items) return items;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseModality(modality: unknown, side: 'input' | 'output'): string[] | undefined {
  const value = stringValue(modality);
  if (!value) return undefined;
  const parts = value.split('->');
  const raw = side === 'input' ? parts[0] : parts[1];
  if (!raw) return undefined;
  return stringArray(raw.split('+').map(part => part.trim()));
}

export function extractModelMetadata(input: unknown): Partial<ModelInfo> {
  const source = asRecord(input);
  const architecture = asRecord(source.architecture);

  const inputTokenLimit = firstNumber([
    source.inputTokenLimit,
    source.input_token_limit,
    source.input_token_limit_tokens,
  ]);
  const outputTokenLimit = firstNumber([
    source.outputTokenLimit,
    source.output_token_limit,
    source.output_token_limit_tokens,
  ]);
  const maxOutputTokens = firstNumber([
    source.maxOutputTokens,
    source.max_output_tokens,
    source.max_completion_tokens,
    outputTokenLimit,
  ]);
  const contextWindow = firstNumber([
    source.contextWindow,
    source.context_window,
    source.contextLength,
    source.context_length,
    source.maxContextTokens,
    source.max_context_tokens,
    source.max_context_length,
    source.max_model_len,
    inputTokenLimit,
  ]);

  const inputModalities = firstStringArray([
    source.inputModalities,
    source.input_modalities,
    source.supportedInputModalities,
    source.supported_input_modalities,
    architecture.inputModalities,
    architecture.input_modalities,
    parseModality(architecture.modality, 'input'),
    parseModality(source.modality, 'input'),
  ]);
  const outputModalities = firstStringArray([
    source.outputModalities,
    source.output_modalities,
    source.supportedOutputModalities,
    source.supported_output_modalities,
    architecture.outputModalities,
    architecture.output_modalities,
    parseModality(architecture.modality, 'output'),
    parseModality(source.modality, 'output'),
  ]);
  const supportedGenerationMethods = firstStringArray([
    source.supportedGenerationMethods,
    source.supported_generation_methods,
    source.supportedActions,
    source.supported_actions,
  ]);
  const supportedMessageRoles = firstStringArray([
    source.supportedMessageRoles,
    source.supported_message_roles,
    source.messageRoles,
    source.message_roles,
  ]);
  const supportedMessageTypes = firstStringArray([
    source.supportedMessageTypes,
    source.supported_message_types,
    source.messageTypes,
    source.message_types,
  ]);
  const supportedParameters = firstStringArray([
    source.supportedParameters,
    source.supported_parameters,
  ]);
  const pricing = asRecord(source.pricing);
  const pricePerMillionTokens = firstNonNegativeNumber([
    source.pricePerMillionTokens,
    source.price_per_million_tokens,
    source.price,
    source.cost,
  ]);
  const inputPricePerMillionTokens = firstNonNegativeNumber([
    source.inputPricePerMillionTokens,
    source.input_price_per_million_tokens,
    source.inputTokenPrice,
    pricing.input,
    pricing.prompt,
  ]);
  const outputPricePerMillionTokens = firstNonNegativeNumber([
    source.outputPricePerMillionTokens,
    source.output_price_per_million_tokens,
    source.outputTokenPrice,
    pricing.output,
    pricing.completion,
  ]);
  const latencyMs = firstNumber([
    source.latencyMs,
    source.latency_ms,
    source.averageLatencyMs,
    source.average_latency_ms,
    source.timeToFirstTokenMs,
    source.time_to_first_token_ms,
  ]);
  const tokensPerSecond = firstNumber([
    source.tokensPerSecond,
    source.tokens_per_second,
    source.throughput,
    source.speed,
  ]);
  const recommendationScore = firstNumber([source.recommendationScore, source.recommendation_score]);
  const qualityScore = firstNumber([source.qualityScore, source.quality_score]);

  const metadata: Partial<ModelInfo> = {};
  if (contextWindow) metadata.contextWindow = contextWindow;
  if (inputTokenLimit) metadata.inputTokenLimit = inputTokenLimit;
  if (outputTokenLimit) metadata.outputTokenLimit = outputTokenLimit;
  if (maxOutputTokens) metadata.maxOutputTokens = maxOutputTokens;
  if (inputModalities) metadata.inputModalities = inputModalities;
  if (outputModalities) metadata.outputModalities = outputModalities;
  if (supportedGenerationMethods) metadata.supportedGenerationMethods = supportedGenerationMethods;
  if (supportedMessageRoles) metadata.supportedMessageRoles = supportedMessageRoles;
  if (supportedMessageTypes) metadata.supportedMessageTypes = supportedMessageTypes;
  if (supportedParameters) metadata.supportedParameters = supportedParameters;
  if (pricePerMillionTokens != null) metadata.pricePerMillionTokens = pricePerMillionTokens;
  if (inputPricePerMillionTokens != null) metadata.inputPricePerMillionTokens = inputPricePerMillionTokens;
  if (outputPricePerMillionTokens != null) metadata.outputPricePerMillionTokens = outputPricePerMillionTokens;
  if (latencyMs) metadata.latencyMs = latencyMs;
  if (tokensPerSecond) metadata.tokensPerSecond = tokensPerSecond;
  if (recommendationScore) metadata.recommendationScore = recommendationScore;
  if (qualityScore) metadata.qualityScore = qualityScore;
  return metadata;
}
