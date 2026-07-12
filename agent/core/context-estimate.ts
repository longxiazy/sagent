import {
  buildGeminiAgentPromptPayload,
  buildNvidiaTaskMessages,
} from './prompts.ts';

const DEFAULT_CONTEXT_WINDOW = 128_000;
const PROMPT_PREVIEW_CHAR_LIMIT = 60_000;

function explicitContextWindow(model: any) {
  const candidates = [
    model?.contextWindow,
    model?.context_window,
    model?.contextLength,
    model?.context_length,
    model?.maxContextTokens,
    model?.max_context_tokens,
    model?.inputTokenLimit,
    model?.input_token_limit,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function inferContextWindow(modelId = '', modelInfo: any = null) {
  const explicit = explicitContextWindow(modelInfo);
  if (explicit) return explicit;

  const id = String(modelId || '').toLowerCase();
  if (/gemini.*(1\.5|2\.0|2\.5|pro|flash)/.test(id)) return 1_000_000;
  if (/kimi/.test(id)) return 200_000;
  if (/qwen.*(235|256|480|coder|long)/.test(id)) return 256_000;
  if (/deepseek/.test(id)) return 128_000;
  if (/nemotron|llama|mistral|mixtral/.test(id)) return 128_000;
  return DEFAULT_CONTEXT_WINDOW;
}

export function estimateTextTokens(text = '') {
  const value = String(text || '');
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const asciiLike = value.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.75 + asciiLike / 4));
}

export function estimatePayloadTokens(value: any): number {
  if (value == null) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean') return estimateTextTokens(String(value));
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimatePayloadTokens(item), 2);
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce(
      (sum, [key, item]) => sum + estimateTextTokens(key) + estimatePayloadTokens(item) + 1,
      2
    );
  }
  return estimateTextTokens(String(value));
}

export function formatTokenCount(tokens: number) {
  return String(Math.round(tokens));
}

export function riskForRatio(ratio: number) {
  if (ratio >= 0.8) return 'danger';
  if (ratio >= 0.5) return 'warning';
  return 'ok';
}

function formatPromptValue(value: any) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function appendPromptSection(parts: string[], title: string, value: any) {
  if (value == null) return;
  parts.push(`## ${title}\n${formatPromptValue(value)}`);
}

function formatPromptMessages(messages: any[]) {
  return messages.map((message, index) => {
    const role = String(message?.role || `message ${index + 1}`).toUpperCase();
    const content = message && Object.prototype.hasOwnProperty.call(message, 'content')
      ? message.content
      : message;
    return `## ${role}\n${formatPromptValue(content)}`;
  }).join('\n\n');
}

function formatGeminiContents(contents: any[]) {
  return contents.map((content, index) => {
    const role = String(content?.role || `content ${index + 1}`).toUpperCase();
    return `## ${role}\n${formatPromptValue(content?.parts ?? content)}`;
  }).join('\n\n');
}

export function buildPromptPreview({
  payload,
  modelId,
  providerName,
  usedTokens,
}: {
  payload: any;
  modelId: string;
  providerName: string;
  usedTokens: number;
}) {
  const sections: string[] = [];
  appendPromptSection(sections, 'MODEL', `${modelId} (${providerName})`);
  appendPromptSection(sections, 'SYSTEM', payload?.system);
  appendPromptSection(sections, 'SYSTEM INSTRUCTION', payload?.systemInstruction);
  if (Array.isArray(payload?.messages)) sections.push(formatPromptMessages(payload.messages));
  if (Array.isArray(payload?.contents)) sections.push(formatGeminiContents(payload.contents));
  appendPromptSection(sections, 'TOOLS', payload?.tools);
  appendPromptSection(sections, 'TOOL CONFIG', payload?.toolConfig);

  const handled = new Set(['system', 'systemInstruction', 'messages', 'contents', 'tools', 'toolConfig']);
  for (const [key, value] of Object.entries(payload || {})) {
    if (!handled.has(key)) appendPromptSection(sections, key.toUpperCase(), value);
  }

  const text = sections.filter(Boolean).join('\n\n');
  const truncated = text.length > PROMPT_PREVIEW_CHAR_LIMIT;
  return {
    modelId,
    provider: providerName,
    usedTokens,
    chars: text.length,
    truncated,
    text: truncated ? text.slice(0, PROMPT_PREVIEW_CHAR_LIMIT) : text,
  };
}

export function buildInitialPlanningObservation(projectRoot?: string | null) {
  const cwd = projectRoot || process.cwd();
  return {
    desktop: { frontmostApp: '', frontmostWindowTitle: '', windows: [] },
    browser: null,
    filesystem: {
      cwd,
      note: '当前工作目录;仅当任务确需读写文件时才使用 fs 工具',
    },
    terminal: {
      cwd,
      note: 'run_safe 仅允许运行只读命令',
    },
    title: 'Desktop',
    url: '',
    text: '',
    elements: [],
  };
}

function buildPlanningPayload({
  providerName,
  task,
  systemPrompt,
  conversationHistory,
  projectRoot,
}: {
  providerName: string;
  task: string;
  systemPrompt?: string | null;
  conversationHistory?: Array<{ role: string; content: string }>;
  projectRoot?: string | null;
}) {
  const baseContext = {
    task,
    systemPrompt,
    step: 1,
    history: [],
    observation: buildInitialPlanningObservation(projectRoot),
    conversationHistory,
  };

  if (providerName === 'gemini') {
    return buildGeminiAgentPromptPayload(baseContext);
  }

  return {
    messages: buildNvidiaTaskMessages(baseContext),
  };
}

export function buildModelContextEstimate({
  modelId,
  modelInfo,
  providerName,
  task,
  systemPrompt,
  conversationHistory,
  projectRoot,
}: {
  modelId: string;
  modelInfo?: any;
  providerName: string;
  task: string;
  systemPrompt?: string | null;
  conversationHistory?: Array<{ role: string; content: string }>;
  projectRoot?: string | null;
}) {
  const payload = buildPlanningPayload({
    providerName,
    task,
    systemPrompt,
    conversationHistory,
    projectRoot,
  });
  const usedTokens = estimatePayloadTokens(payload);
  const windowTokens = inferContextWindow(modelId, modelInfo);
  const ratio = windowTokens > 0 ? Math.min(1, usedTokens / windowTokens) : 0;
  const promptPreview = buildPromptPreview({ payload, modelId, providerName, usedTokens });

  return {
    modelId,
    provider: providerName,
    usedTokens,
    windowTokens,
    ratio,
    percent: Math.round(ratio * 100),
    risk: riskForRatio(ratio),
    promptPreview,
  };
}

export function summarizeContextEstimates(modelEstimates: any[]) {
  const estimates = modelEstimates.length > 0 ? modelEstimates : [{
    modelId: null,
    provider: 'unknown',
    usedTokens: 0,
    windowTokens: DEFAULT_CONTEXT_WINDOW,
    ratio: 0,
    percent: 0,
    risk: 'ok',
  }];
  const max = estimates.reduce((acc, item) => item.ratio > acc.ratio ? item : acc, estimates[0]);
  const averageRatio = estimates.reduce((sum, item) => sum + item.ratio, 0) / estimates.length;
  const averageWindowTokens = Math.round(estimates.reduce((sum, item) => sum + item.windowTokens, 0) / estimates.length);
  const stripPromptPreview = (estimate: any) => {
    if (!estimate || typeof estimate !== 'object') return estimate;
    const { promptPreview, ...rest } = estimate;
    return rest;
  };

  return {
    source: 'server_actual_prompt',
    usedTokens: max.usedTokens,
    max: stripPromptPreview(max),
    average: {
      windowTokens: averageWindowTokens,
      ratio: averageRatio,
      percent: Math.round(averageRatio * 100),
      risk: riskForRatio(averageRatio),
    },
    modelCount: estimates.length,
    modelEstimates: estimates.map(stripPromptPreview),
    promptPreview: max.promptPreview || null,
    risk: max.risk,
    percent: max.percent,
    ratio: max.ratio,
    usedLabel: formatTokenCount(max.usedTokens),
    maxWindowLabel: formatTokenCount(max.windowTokens),
    averageWindowLabel: formatTokenCount(averageWindowTokens),
  };
}
