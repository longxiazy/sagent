/**
 * LLMProvider — 可插拔的 LLM 供应商统一接口
 *
 * 每家供应商（Anthropic / Gemini / OpenAI 兼容）把自身的 API 差异
 * （client 构造、模型列表、模型归属判断、agent 决策、chat/completion、记忆摘要、
 *  usage 归一化）全部封装在各自的 createXxxProvider() 工厂里。
 *
 * 核心调用点（planner / routes / summarizer / server）只面向本接口 + registry，
 * 不再出现 `isClaudeModel ? ... : ...` 这类二选一硬编码。
 *
 * 加第四家 = 新增一个 createXxxProvider() 实现这些方法 + registry 里注册一行。
 */

import type { Response } from 'express';

// 归一化后的模型信息。provider 是「展示名」（anthropic / gemini / nvidia 等，
// 由 baseURL 推断），前端徽标依赖它；与下面 LLMProvider.name 这个「内部路由标识」区分开。
export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
}

// agent 决策上下文（task/step/history/observation/conversationHistory/systemPrompt 等），
// 由 runtime 的 decide 阶段透传，各 provider 自行决定如何构造 messages。
export interface AgentPlanOpts {
  model: string;
  signal?: AbortSignal;
  systemPrompt?: string | null;
  task?: string;
  step?: number;
  history?: any[];
  observation?: any;
  conversationHistory?: Array<{ role: string; content: string }>;
  [key: string]: any;
}

// agent 决策的归一化返回，对齐现有 planner 的输出形状。
export interface AgentPlanResult {
  rationale?: string;
  action: any;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  reasoning?: string | null;
}

export interface CompletionOpts {
  model: string;
  messages: any[];
  temperature: number;
  top_p: number;
  max_tokens: number;
}

export interface CompletionStreamOpts extends CompletionOpts {
  res: Response;
}

export interface SummarizeOpts {
  text: string;
  model: string;
}

export interface LLMProvider {
  // 内部路由标识，registry.resolve 用；与 ModelInfo.provider（展示名）不同。
  readonly name: 'anthropic' | 'gemini' | 'openai-compat';
  // 底层 SDK client，server resume 等处需要判断其是否存在。
  readonly client: any;

  // 是否「认领」某模型。registry 先用它精确匹配，匹配不到再兜底到 openai-compat。
  ownsModel(model: string, modelConfig?: ModelInfo[] | null): boolean;

  // 从供应商 /v1/models 拉取并归一成 ModelInfo[]；失败直接抛错，由 registry 聚合各家原因，
  // 全部失败时中止启动（不再兜底默认模型）。
  listModels(): Promise<ModelInfo[]>;

  // agent 决策：调用 LLM → 解析 → 归一成 { rationale, action, usage, reasoning }。
  agentPlan(opts: AgentPlanOpts): Promise<AgentPlanResult>;

  // /v1/chat/completions 非流式：返回标准 chat.completion 对象。
  completionJson(opts: CompletionOpts): Promise<any>;

  // /v1/chat/completions 流式：流式写 SSE（含 [DONE]）。
  completionStream(opts: CompletionStreamOpts): Promise<void>;

  // 记忆压缩用的一次性文本摘要。
  summarize(opts: SummarizeOpts): Promise<string>;
}
