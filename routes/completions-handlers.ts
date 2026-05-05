import { buildOpenAiError } from '../helpers/streaming.ts';
import { buildClaudeUsage, initSse, writeSse, writeSseDone } from './llm-route-utils.ts';

function buildChatCompletionResponse({ model, text, finishReason, usage }: { model: string; text: string; finishReason: string; usage: any }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: finishReason,
    }],
    usage,
  };
}

function buildChatChunk({ model, content, finishReason }: { model: string; content?: string; finishReason: string | null }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

export async function handleClaudeCompletionJson({
  client,
  model,
  messages,
  max_tokens,
  temperature,
}: {
  client: any;
  model: string;
  messages: any[];
  max_tokens: number;
  temperature: number;
}) {
  const response = await client.messages.create({
    model,
    max_tokens,
    temperature,
    messages,
  });
  const text = response.content.find((block: any) => block.type === 'text')?.text || '';
  const usage = buildClaudeUsage(response.usage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return buildChatCompletionResponse({
    model,
    text,
    finishReason: response.stop_reason || 'stop',
    usage,
  });
}

export async function handleOpenAiCompletionJson({
  client,
  model,
  messages,
  temperature,
  top_p,
  max_tokens,
}: {
  client: any;
  model: string;
  messages: any[];
  temperature: number;
  top_p: number;
  max_tokens: number;
}) {
  return client.chat.completions.create({
    model,
    messages,
    temperature,
    top_p,
    max_tokens,
  });
}

export async function handleClaudeCompletionStream({
  client,
  model,
  messages,
  max_tokens,
  temperature,
  res,
}: {
  client: any;
  model: string;
  messages: any[];
  max_tokens: number;
  temperature: number;
  res: any;
}) {
  initSse(res);
  const stream = client.messages.stream({
    model,
    max_tokens,
    temperature,
    messages,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      writeSse(res, buildChatChunk({ model, content: event.delta.text, finishReason: null }));
    } else if (event.type === 'message_delta') {
      writeSse(res, buildChatChunk({ model, finishReason: event.delta?.stop_reason || 'stop' }));
    }
  }

  writeSseDone(res);
  return res.end();
}

export async function handleOpenAiCompletionStream({
  createStreamingCompletion,
  model,
  messages,
  temperature,
  top_p,
  max_tokens,
  res,
}: {
  createStreamingCompletion: any;
  model: string;
  messages: any[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  res: any;
}) {
  const completion = await createStreamingCompletion(
    {
      model,
      messages,
      temperature,
      top_p,
      max_tokens,
    },
    { includeUsage: true }
  );

  initSse(res);
  for await (const chunk of completion) {
    writeSse(res, chunk);
  }
  writeSseDone(res);
  return res.end();
}

export function writeCompletionStreamError(res: any, err: any) {
  const error = buildOpenAiError(err.message);
  writeSse(res, error.body);
  writeSseDone(res);
  return res.end();
}
