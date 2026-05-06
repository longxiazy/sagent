import { isClaudeModel } from '../agent/core/ai-client.ts';

export function initSse(res: any) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

export function writeSse(res: any, payload: any) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeSseDone(res: any) {
  res.write('data: [DONE]\n\n');
}

export function requireLlmClient({
  model,
  modelConfig,
  openai_client,
  anthropic_client,
  anthropicError = '未配置 ANTHROPIC_API_KEY',
  nvidiaError = '未配置 NVIDIA_API_KEY',
}: {
  model: string;
  modelConfig: any[];
  openai_client: any;
  anthropic_client: any;
  anthropicError?: string;
  nvidiaError?: string;
}) {
  const useClaude = isClaudeModel(model, modelConfig);
  if (useClaude && !anthropic_client) {
    throw new Error(anthropicError);
  }
  if (!useClaude && !openai_client) {
    throw new Error(nvidiaError);
  }
  return {
    useClaude,
    client: useClaude ? anthropic_client : openai_client,
  };
}

export function buildClaudeUsage(usage: any) {
  if (!usage) {
    return null;
  }
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}
