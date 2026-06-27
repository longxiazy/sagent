/**
 * OpenAICompatProvider — OpenAI 兼容供应商（NVIDIA NIM 及任意 OpenAI 兼容端点）
 *
 * 这类供应商不一定支持原生 function calling，agent 决策走「JSON-in-prompt」+
 * nvidia-response-parsers 多策略解析（createJsonPlanner）。completion 走标准
 * OpenAI SDK。是 registry 的兜底 provider（ownsModel 恒 false，由 resolve 兜底）。
 */

import { createJsonPlanner } from '../planner.ts';
import { normalizeDesktopAgentDecision } from '../schemas.ts';
import { buildNvidiaTaskMessages } from '../prompts.ts';
import { deriveProviderName, isChatCapableModel } from '../ai-client.ts';
import {
  createStreamingCompletionFactory,
  initSse,
  writeSse,
  writeSseDone,
} from '../../../helpers/streaming.ts';
import { retryAsync } from '../../../helpers/retry.ts';
import { log } from '../../../helpers/logger.ts';
import { buildSummaryPrompt } from './anthropic.ts';
import type {
  LLMProvider,
  ModelInfo,
  AgentPlanOpts,
  AgentPlanResult,
  CompletionOpts,
  CompletionStreamOpts,
  SummarizeOpts,
} from './types.ts';

export function createOpenAICompatProvider(client: any): LLMProvider {
  const createStreamingCompletion = createStreamingCompletionFactory(client);

  // agent 决策器：JSON-in-prompt + 多策略解析，解析失败带提示重试一次（逻辑在 createJsonPlanner 内）。
  const planner = createJsonPlanner({
    client,
    buildMessages: (ctx: any) => buildNvidiaTaskMessages(ctx),
    normalizeDecision: normalizeDesktopAgentDecision,
    buildParserError(err: Error) {
      return `模型动作解析失败: ${err.message}`;
    },
  });

  return {
    name: 'openai-compat',
    client,

    // 兜底 provider，不主动认领模型——registry.resolve 在没有其它 provider 认领时回退到它。
    ownsModel() {
      return false;
    },

    async listModels() {
      const models: ModelInfo[] = [];
      const providerName = deriveProviderName(process.env.NVIDIA_BASE_URL);
      // 失败直接抛错，由 registry 聚合原因；全部供应商失败时中止启动。
      const list = await client.models.list();
      for (const m of list.data || []) {
        if (m?.id && isChatCapableModel(m.id)) {
          models.push({ id: m.id, label: m.id, provider: providerName });
        }
      }
      return models;
    },

    async agentPlan(opts: AgentPlanOpts): Promise<AgentPlanResult> {
      const { model, signal, ...context } = opts;
      return planner({ model, signal, ...context });
    },

    async completionJson(opts: CompletionOpts) {
      const { model, messages, temperature, top_p, max_tokens } = opts;
      return client.chat.completions.create({ model, messages, temperature, top_p, max_tokens });
    },

    async completionStream(opts: CompletionStreamOpts) {
      const { model, messages, temperature, top_p, max_tokens, res } = opts;
      const completion = await createStreamingCompletion(
        { model, messages, temperature, top_p, max_tokens },
        { includeUsage: true }
      );
      initSse(res);
      for await (const chunk of completion) {
        writeSse(res, chunk);
      }
      writeSseDone(res);
      res.end();
    },

    async summarize(opts: SummarizeOpts) {
      const { text, model } = opts;
      const prompt = buildSummaryPrompt(text);
      const resp = await retryAsync(() => client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
      }));
      return resp?.choices?.[0]?.message?.content || text.slice(0, 300);
    },
  };
}
