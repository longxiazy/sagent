/**
 * AI Client — 统一的 LLM 客户端层，屏蔽 NVIDIA / Anthropic 两套 API 差异
 *
 * 职责：
 *   1. 管理 OpenAI (NVIDIA) 和 Anthropic (Claude) 两套 SDK 客户端
 *   2. 从环境变量加载模型配置（MODELS, AGENT_MULTI_MODELS）
 *   3. 提供 Claude 专用的 claudeAgentPlan() — 通过 Anthropic SDK 原生 tool_use 调用
 *
 * 调用场景：
 *   - server.js 启动时调用 createClients() 创建客户端、loadModelConfig() 加载模型列表
 *   - agent/desktop/agent.js 的 singleModelPlan() 中：
 *     Claude 模型走 claudeAgentPlan()，NVIDIA 模型走 planner.js 的 createJsonPlanner()
 *   - planner.js 的 createJsonPlanner() 内部调用 openai_client.chat.completions.create()
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logLlmRequest, logLlmResponse } from './llm-logger.js';
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

export function buildDesktopAgentSystemPrompt(systemPrompt, planningMode = false) {
  const planningSection = planningMode
    ? '

## 规划模式 (Planning Mode)
当你收到任务时，先不执行，先制定详细的执行计划，' \n      '用 ask_user 展示给用户批准后再按计划执行。计划格式：
1. 第一步：做什么 + 为什么
2. 第二步：...' \n      '确认后再执行，完成后汇报。'
    : '';

  const base = [
    '你是 DesktopAgent，负责在浏览器、macOS 桌面、文件系统、终端之间协同完成任务。' + planningSection,
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
