/**
 * AI Client — Unified LLM client layer, abstracting NVIDIA (OpenAI-compatible) / Anthropic API differences
 * AI 客户端 — 统一的 LLM 客户端层，屏蔽 NVIDIA / Anthropic 两套 API 差异
 *
 * 职责 / Responsibilities:
 *   1. 管理 OpenAI (NVIDIA) 和 Anthropic (Claude) 两套 SDK 客户端
 *      Manage OpenAI (NVIDIA) and Anthropic (Claude) SDK clients
 *   2. 从环境变量加载模型配置（MODELS, AGENT_MULTI_MODELS）
 *      Load model configuration from env vars (MODELS, AGENT_MULTI_MODELS)
 *   3. 提供 Claude 专用的 claudeAgentPlan() — 通过 Anthropic SDK 原生 tool_use 调用
 *      Claude-specific planning via Anthropic SDK native tool_use
 *   4. 提供 summarizeText() — 用于记忆压缩的 LLM 文本摘要
 *      LLM text summarization for memory compaction via summarizeText()
 *
 * 调用场景 / Callers:
 *   - server.js 启动时: createClients() 创建客户端、loadModelConfig() 加载模型列表
 *   - agent/desktop/agent.js singleModelPlan():
 *     Claude 模型走 claudeAgentPlan()，NVIDIA 模型走 planner.js 的 createJsonPlanner()
 *   - routes/agent.js 异步记忆保存: summarizeText() 用于压缩对话记忆
 *
 * TODO / 拆分建议 Refactor suggestions:
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logLlmRequest, logLlmResponse } from './llm-logger.ts';
import { retryAsync } from '../../helpers/retry.ts';
import { createModelTools, toolToClaudeTool } from './tool-definitions.ts';

export { createModelTools } from './tool-definitions.ts';

export function loadModelConfig() {
  const envModels = process.env.MODELS;
  if (typeof envModels === 'string' && envModels.trim()) {
    const ids = envModels.split(',').map(s => s.trim()).filter(Boolean);
    const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const onlyAnthropic = hasAnthropicKey && !process.env.NVIDIA_API_KEY;
    return ids.map(id => ({
      id,
      label: id,
      provider: id.startsWith('claude-') || onlyAnthropic ? 'anthropic' : 'nvidia',
    }));
  }
  if (process.env.ANTHROPIC_API_KEY && !process.env.NVIDIA_API_KEY) {
    return [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' }];
  }
  return [{ id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', provider: 'nvidia' }];
}

export function loadAgentMultiModels() {
  const env = process.env.AGENT_MULTI_MODELS;
  if (typeof env === 'string' && env.trim()) {
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export function isClaudeModel(model, modelConfig) {
  if (modelConfig) {
    return modelConfig.some(m => m.id === model && m.provider === 'anthropic');
  }
  return model?.startsWith('claude-');
}

// ── API Key Validation ──
// Validates configured API keys at startup for format issues and provides
// user-friendly error messages instead of raw JavaScript stack traces.

/**
 * Validate configured API keys and exit gracefully if none are configured.
 * Prints warnings for potential format issues (newlines, whitespace, suspicious length).
 * Called during server startup in server.ts.
 */
export function validateApiKeys(): void {
  const keys: { name: string; envVar: string }[] = [
    { name: 'NVIDIA_API_KEY', envVar: 'NVIDIA_API_KEY' },
    { name: 'ANTHROPIC_API_KEY', envVar: 'ANTHROPIC_API_KEY' },
  ];

  const warnings: string[] = [];
  const configured: string[] = [];

  for (const { name, envVar } of keys) {
    const key = process.env[envVar];
    if (!key || !key.trim()) continue;
    configured.push(name);

    if (key.includes('\n')) {
      warnings.push(`${name} 包含换行符，可能导致认证失败`);
    }
    if (key.startsWith(' ') || key.endsWith(' ')) {
      warnings.push(`${name} 前后包含多余空格，建议去除`);
    }
    if (key.length < 20) {
      warnings.push(`${name} 长度异常（${key.length} 字符），请检查是否完整`);
    }
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  API Key 配置警告:');
    for (const w of warnings) console.warn(`  ⚠  ${w}`);
    console.warn();
  }

  if (configured.length === 0) {
    console.error('\n❌ API Key 验证失败:');
    console.error('  未配置任何 API Key。请至少设置 NVIDIA_API_KEY 或 ANTHROPIC_API_KEY 环境变量');
    console.error();
    console.error('  配置方式：');
    console.error('    1. 创建 .env 文件：echo "NVIDIA_API_KEY=nvapi-xxx" > .env');
    console.error('    2. 或设置环境变量：export NVIDIA_API_KEY="nvapi-xxx"');
    console.error();
    process.exit(1);
  }
}

export function createClients() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const openai_client = nvidiaKey
    ? new OpenAI({ apiKey: nvidiaKey, baseURL: 'https://integrate.api.nvidia.com/v1', maxRetries: 0 })
    : null;

  const anthropic_client = anthropicKey
    ? new Anthropic({ apiKey: anthropicKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined })
    : null;

  if (!openai_client && !anthropic_client) {
    console.error('\n❌ 配置错误：至少需要设置 NVIDIA_API_KEY 或 ANTHROPIC_API_KEY');
    console.error('  配置方式：');
    console.error('    1. 创建 .env 文件：echo "NVIDIA_API_KEY=nvapi-xxx" > .env');
    console.error('    2. 或设置环境变量：export NVIDIA_API_KEY="nvapi-xxx"');
    console.error();
    process.exit(1);
  }

  return { openai_client, anthropic_client };
}

export async function claudeAgentPlan({
  client,
  model,
  maxTokens = 16000,
  temperature: _temperature = 0.1,
  system,
  messages,
  signal,
}) {
  const tools = createModelTools().map(toolToClaudeTool);

  const streamOpts: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    tools,
    system,
    messages,
  };
  if (signal) streamOpts.signal = signal;

  logLlmRequest(model, messages);

  const stream = await retryAsync(() => client.messages.stream(streamOpts));

  for await (const _event of stream) {
    // Stream events — we use the final message for complete tool_use data
  }

  const message = await stream.finalMessage();

  logLlmResponse(model, { usage: message.usage, choices: [{ message }] });

  // Extract tool_use block from the complete message
  const toolBlock = message.content.find(b => b.type === 'tool_use');
  if (toolBlock) {
    return {
      content: { name: toolBlock.name, input: toolBlock.input },
      stop_reason: message.stop_reason,
      usage: message.usage,
    };
  }

  // Fallback: try to find text block and parse it as JSON (for finish action)
  const textBlock = message.content.find(b => b.type === 'text');
  if (textBlock?.text) {
    try {
      return { content: JSON.parse(textBlock.text), stop_reason: message.stop_reason, usage: message.usage };
    } catch {
      // not JSON
    }
  }

  throw new Error(`Claude 未返回有效工具调用，停止原因: ${message.stop_reason}`);
}