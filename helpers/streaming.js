import { log } from './logger.js';

export function buildMetrics(startedAt, usage) {
  const elapsedMs = Date.now() - startedAt;
  const elapsedSeconds = elapsedMs > 0 ? elapsedMs / 1000 : 0;
  const completionTokens = usage?.completion_tokens ?? null;

  return {
    elapsed_ms: elapsedMs,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: completionTokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    tokens_per_second:
      completionTokens && elapsedSeconds > 0
        ? Number((completionTokens / elapsedSeconds).toFixed(2))
        : null,
  };
}

export function buildOpenAiError(message, type = 'api_error', status = 500) {
  return {
    status,
    body: {
      error: {
        message,
        type,
      },
    },
  };
}

function shouldRetryWithoutUsage(err) {
  const message = err?.message?.toLowerCase?.() || '';
  return (
    err?.status === 400 &&
    (message.includes('stream_options') ||
      message.includes('include_usage') ||
      message.includes('unknown parameter'))
  );
}

export function createStreamingCompletionFactory(openai_client) {
  return async function createStreamingCompletion(request, { includeUsage = false } = {}) {
    const baseRequest = {
      ...request,
      stream: true,
    };

    if (!includeUsage) {
      return openai_client.chat.completions.create(baseRequest);
    }

    try {
      return await openai_client.chat.completions.create({
        ...baseRequest,
        stream_options: { include_usage: true },
      });
    } catch (err) {
      if (!shouldRetryWithoutUsage(err)) {
        throw err;
      }
      log.warn('stream_options.include_usage 不受支持，改为无 usage 重试:', err.message);
      return openai_client.chat.completions.create(baseRequest);
    }
  };
}
