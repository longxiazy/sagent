/**
 * GeminiProvider — Google Gemini（@google/genai 原生 SDK）
 *
 * 封装 Gemini 的 API 差异：
 *   - contents/parts 格式（assistant→model 角色映射）
 *   - 原生 function calling（functionDeclarations + toolConfig mode=ANY → functionCalls）
 *   - 流式 generateContentStream（chunk.text / chunk.functionCalls）
 *   - usageMetadata → 归一 usage
 */

import { GoogleGenAI } from '@google/genai';
import {
  buildDesktopAgentSystemPrompt,
  buildGeminiTaskMessages,
} from '../prompts.ts';
import { createModelTools, toolToGeminiTool } from '../tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../schemas.ts';
import { isChatCapableModel } from '../ai-client.ts';
import { resolveAgentMaxTokens } from '../planner.ts';
import { logLlmRequest, logLlmResponse } from '../llm-logger.ts';
import { initSse, writeSse, writeSseDone } from '../../../helpers/streaming.ts';
import { retryAsync } from '../../../helpers/retry.ts';
import { buildSummaryPrompt } from './summary-prompt.ts';
import { extractModelMetadata } from './model-metadata.ts';
import { configStore } from '../config-store.ts';
import type {
  LLMProvider,
  ModelInfo,
  AgentPlanOpts,
  AgentPlanResult,
  CompletionOpts,
  CompletionStreamOpts,
  SummarizeOpts,
} from './types.ts';

// Gemini usageMetadata → 内部归一 usage。
function buildGeminiUsage(meta: any) {
  if (!meta) return null;
  return {
    prompt_tokens: meta.promptTokenCount || 0,
    completion_tokens: meta.candidatesTokenCount || 0,
  };
}

function dataUrlToInlineData(url: string) {
  const match = String(url || '').match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function toGeminiPart(part: any) {
  if (!part || typeof part !== 'object') return { text: String(part ?? '') };
  if (part.type === 'text') {
    return { text: typeof part.text === 'string' ? part.text : '' };
  }
  if (part.type === 'image_url') {
    const url = typeof part.image_url === 'string'
      ? part.image_url
      : part.image_url?.url;
    const inlineData = dataUrlToInlineData(url);
    if (inlineData) return { inlineData };
    return { text: `[image_url: ${url || 'unsupported'}]` };
  }
  return { text: JSON.stringify(part) };
}

// 把 OpenAI 风格 chat messages（system/user/assistant）转成 Gemini contents + systemInstruction。
// 返回 { systemInstruction, contents }。assistant → model；system 抽出来单独传。
function toGeminiContents(messages: any[]) {
  let systemInstruction: string | undefined;
  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = systemInstruction ? `${systemInstruction}\n${msg.content}` : msg.content;
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = Array.isArray(msg.content)
      ? msg.content.map(toGeminiPart)
      : [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }];
    contents.push({ role, parts });
  }
  return { systemInstruction, contents };
}

export function createGeminiProvider(client: GoogleGenAI): LLMProvider {
  return {
    name: 'gemini',
    client,

    ownsModel(model: string, modelConfig?: ModelInfo[] | null) {
      if (modelConfig) {
        return modelConfig.some(m => m.id === model && m.provider === 'gemini');
      }
      return typeof model === 'string' && model.startsWith('gemini');
    },

    async listModels() {
      const models: ModelInfo[] = [];
      // 失败直接抛错，由 registry 聚合原因；全部供应商失败时中止启动。
      const pager = await client.models.list();
      for await (const m of pager) {
        // m.name 形如 'models/gemini-2.5-flash'；剥离前缀作为 id。
        const rawName: string = (m as any).name || '';
        const id = rawName.replace(/^models\//, '');
        if (!id) continue;
        // 仅保留能做对话决策的模型。注意 tts / image 类模型也声明了 generateContent，
        // 无法靠 supportedActions 区分，必须按 id 过滤。
        const actions: string[] = (m as any).supportedActions || (m as any).supportedGenerationMethods || [];
        const supportsGenerate = !actions.length || actions.includes('generateContent');
        if (!supportsGenerate) continue;
        if (!isChatCapableModel(id)) continue;
        if (/imagen|veo|embedding|aqa|tts|-image|image-|gemma-(?:2|3n)/i.test(id)) continue;
        models.push({
          id,
          label: (m as any).displayName || id,
          provider: 'gemini',
          ...extractModelMetadata(m),
        });
      }
      return models;
    },

    async agentPlan(opts: AgentPlanOpts): Promise<AgentPlanResult> {
      const { model, signal, systemPrompt, modelConfig, toolMode = 'full' } = opts;
      const system = buildDesktopAgentSystemPrompt(systemPrompt, toolMode as 'full' | 'readonly', opts as any);
      const { contents } = buildGeminiTaskMessages(opts as any);
      const tools = [{ functionDeclarations: createModelTools({ mode: toolMode as 'full' | 'readonly' }).map(toolToGeminiTool) }];
      const toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      const maxOutputTokens = resolveAgentMaxTokens({
        model,
        modelConfig,
        requestedMaxTokens: configStore.get().maxOutputTokens,
        promptPayload: { systemInstruction: system, contents, tools, toolConfig },
      });

      const config: Record<string, any> = {
        systemInstruction: system,
        maxOutputTokens,
        temperature: 0.1,
        tools,
        toolConfig,
      };
      if (signal) config.abortSignal = signal;

      logLlmRequest(model, contents);
      const response = await retryAsync(() => client.models.generateContent({ model, contents, config } as any), undefined, undefined, { retryRateLimit: false });
      const usage = buildGeminiUsage((response as any).usageMetadata);
      logLlmResponse(model, { usage: { input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens }, choices: [{ message: response }] });

      const calls = (response as any).functionCalls;
      if (Array.isArray(calls) && calls.length > 0) {
        const call = calls[0];
        const action = { type: call.name, ...(call.args || {}) };
        const decision = normalizeDesktopAgentDecision({ action });
        return { ...decision, usage, reasoning: null };
      }

      // fallback：把纯文本当作 JSON finish 动作尝试解析
      const text = (response as any).text;
      if (typeof text === 'string' && text.trim()) {
        try {
          const decision = normalizeDesktopAgentDecision(JSON.parse(text));
          return { ...decision, usage, reasoning: null };
        } catch {
          // not JSON
        }
      }
      throw new Error('Gemini 未返回有效的 functionCall');
    },

    async completionJson(opts: CompletionOpts) {
      const { model, messages, temperature, max_tokens, signal } = opts;
      const { systemInstruction, contents } = toGeminiContents(messages);
      const config: Record<string, any> = { maxOutputTokens: max_tokens, temperature };
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (signal) config.abortSignal = signal;

      const response = await client.models.generateContent({ model, contents, config } as any);
      const text = (response as any).text || '';
      const u = buildGeminiUsage((response as any).usageMetadata);
      const usage = u
        ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.prompt_tokens + u.completion_tokens }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      };
    },

    async completionStream(opts: CompletionStreamOpts) {
      const { model, messages, temperature, max_tokens, res } = opts;
      const { systemInstruction, contents } = toGeminiContents(messages);
      const config: Record<string, any> = { maxOutputTokens: max_tokens, temperature };
      if (systemInstruction) config.systemInstruction = systemInstruction;

      initSse(res);
      const stream = await client.models.generateContentStream({ model, contents, config } as any);
      for await (const chunk of stream) {
        const text = (chunk as any).text;
        if (text) {
          writeSse(res, {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
        }
      }
      writeSseDone(res);
      res.end();
    },

    async summarize(opts: SummarizeOpts) {
      const { text, model } = opts;
      const prompt = buildSummaryPrompt(text);
      const response = await retryAsync(() => client.models.generateContent({
        model,
        contents: prompt,
        config: { maxOutputTokens: 800, temperature: 0.1 },
      } as any));
      return (response as any).text || text.slice(0, 300);
    },
  };
}
