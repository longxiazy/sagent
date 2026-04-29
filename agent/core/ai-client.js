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
 *   - 将 summarizeText() 拆到 agent/core/summarizer.js（摘要逻辑与客户端管理解耦）
 *   - 将 buildDesktopAgentSystemPrompt() 拆到 agent/core/prompts.js（Prompt 模板集中管理）
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logLlmRequest, logLlmResponse } from './llm-logger.js';
import { displayWidth, padEndW } from './utils.js';
import { log } from '../../helpers/logger.js';
import { retryAsync } from '../../helpers/retry.js';
import { createModelTools, toolToClaudeTool } from './tool-definitions.js';

export { createModelTools } from './tool-definitions.js';

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

export function createClients() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const openai_client = nvidiaKey
    ? new OpenAI({ apiKey: nvidiaKey, baseURL: 'https://integrate.api.nvidia.com/v1' })
    : null;

  const anthropic_client = anthropicKey
    ? new Anthropic({ apiKey: anthropicKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined })
    : null;

  if (!openai_client && !anthropic_client) {
    throw new Error('至少需要配置 NVIDIA_API_KEY 或 ANTHROPIC_API_KEY');
  }

  return { openai_client, anthropic_client };
}

export function buildDesktopAgentSystemPrompt(systemPrompt) {
  const base = [
    '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。',
    '通过工具调用完成任务，只能使用提供的工具，不要输出 JSON 以外的文本。',
    '规则：',
    '1. 只有 observation.browser.elements 中存在的 elementId 才能用于 click/type。',
    '2. 优先使用已知信息，不要重复无意义截图或重复读同一文件。任务一旦完成，必须立即返回 {"action":{"tool":"core","type":"finish","answer":"结果"}}，绝不能重复执行已成功的动作。',
    '3. 文件写入、终端确认命令、桌面键鼠输入可能需要用户批准，被拒绝后请尝试替代方案。',
    '4. cd/pushd/popd 等目录切换命令使用 run_review，需要用户审批。',
    '5. answer 用简体中文，简洁直接。',
    '6. 获取网页信息时优先用 http_fetch（快，不开浏览器）。需要搜索时优先使用 google_search 工具，它会用浏览器打开 Google 并提取搜索结果。http_fetch 也可用于搜索（构造搜索 URL，设 extractLinks=true 提取链接），但 Google 等搜索引擎可能需要浏览器。',
    '7. http_fetch 返回空内容或失败时，才切换 browser.navigate 或 google_search。浏览器操作开销大，仅在 JS 动态渲染、需登录、需交互时使用。',
    '8. 需要用户输入或确认偏好时使用 ask_user，不要自行假设。',
    '9. 执行中发现重要信息或潜在问题时使用 notify_user 主动告知用户。',
    systemPrompt ? `附加约束：${systemPrompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return base;
}

export async function claudeAgentPlan({
  client,
  model,
  maxTokens = 16000,
  temperature = 0.1,
  system,
  messages,
  signal,
}) {
  const tools = createModelTools().map(toolToClaudeTool);

  const streamOpts = {
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

export async function summarizeText({ text, openai_client, anthropic_client, model }) {
  const shortModel = model?.split('/').pop() || '?';
  const startTime = Date.now();
  const reqLine = `  >>> 记忆摘要 REQUEST  ${shortModel}  input=${text.length}字`;
  const w = Math.max(displayWidth(reqLine) + 4, 52);
  log.info(`\n  ${'╔' + '═'.repeat(w) + '╗'}\n  ║${padEndW(reqLine, w)}║\n  ${'╚' + '═'.repeat(w) + '╝'}`);

  const prompt = `请用简洁的中文提炼以下 Agent 任务记录的关键信息。要求：
1. 相同或相似主题的任务合并为一条，不要重复
2. 每个任务一行，格式：任务→结果要点
3. 保留重要的事实、数据和结论
4. 去除冗余细节

${text}`;
  try {
    let result;
    const useClaude = isClaudeModel(model, null);
    if (useClaude && anthropic_client) {
      const resp = await retryAsync(() => anthropic_client.messages.create({
        model,
        max_tokens: 800,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }));
      result = resp.content.find(b => b.type === 'text')?.text || text.slice(0, 300);
    } else if (openai_client) {
      const resp = await retryAsync(() => openai_client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 800,
      }));
      result = resp.choices[0]?.message?.content || text.slice(0, 300);
    } else {
      result = text.slice(0, 300);
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const resLine = `  <<< 记忆摘要 RESPONSE ${shortModel}  ${elapsed}s  output=${result.length}字`;
    const rw = Math.max(displayWidth(resLine) + 4, 52);
    log.info(`\n  ${'╔' + '═'.repeat(rw) + '╗'}\n  ║${padEndW(resLine, rw)}║\n  ${'╚' + '═'.repeat(rw) + '╝'}`);
    return result;
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errLine = `  !!! 记忆摘要 FAILED   ${shortModel}  ${elapsed}s  ${err.message.slice(0, 60)}`;
    const ew = Math.max(displayWidth(errLine) + 4, 52);
    log.warn(`\n  ${'╔' + '═'.repeat(ew) + '╗'}\n  ║${padEndW(errLine, ew)}║\n  ${'╚' + '═'.repeat(ew) + '╝'}`);
    throw err;
  }
}
