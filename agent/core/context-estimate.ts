/**
 * Context Estimate — 提示词 token/上下文占用估算
 *
 * 用途：按供应商实际 prompt 构造逻辑（gemini → contents，nvidia → messages）
 * 估算单步 payload 的 token 与模型上下文窗口的占用比例，供前端显示
 * 「预计上下文占用/风险」及 prompt 预览。
 *
 * 调用场景：
 *   - routes/agent-context.ts：单个模型估算 + 多模型汇总（max/平均/风险档）
 *   - agent/core/planner.ts：单模型上下文窗口推断与 token 估算
 *   - scripts/prompt-benchmark.ts / trace-eval.ts：离线提示词对比与 trace 回放统计
 */

import {
  buildGeminiAgentPromptPayload,
  buildNvidiaTaskMessages,
} from './prompts.ts';

/** 未识别模型的兜底上下文窗口。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** prompt 预览文本截断上限。 */
const PROMPT_PREVIEW_CHAR_LIMIT = 60_000;

/** 从模型信息对象中依次尝试各命名习惯的窗口字段（contextWindow/context_window 等）。 */
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

/**
 * 推断模型上下文窗口：优先取 modelInfo 显式字段，否则按模型 id 关键词匹配已知档位。
 * 当前使用：routes/agent-context.ts 的估算、planner.ts 的窗口判断。
 */
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

/** 估算纯文本 token 数：CJK 按 0.75 计、其它按 4 字符计，空串返回 0。 */
export function estimateTextTokens(text = '') {
  const value = String(text || '');
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const asciiLike = value.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.75 + asciiLike / 4));
}

/** 递归估算任意 payload（字符串/数字/数组/对象）的 token 数。
 *  当前使用：planner.ts 的 prompt token 统计、prompt-benchmark.ts 与 trace-eval.ts 的离线对比。 */
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

/** 占用比例 → 风险档：≥80% danger，≥50% warning，否则 ok。 */
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

/** 把请求 payload 各段拼成可读文本预览（截断 60k 字符），供前端展示。 */
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

/** 单模型上下文占用估算：按供应商构造实际 payload 后估算 token 与占用比例。
 *  当前使用：routes/agent-context.ts（GET /api/agent/context-estimate）。 */
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

/** 汇总多模型估算：取 max 最坏情况与平均值，去掉 promptPreview 后返回。
 *  当前使用：routes/agent-context.ts 的汇总响应。 */
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
