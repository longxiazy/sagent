import { log } from './logger.ts';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryableError(err) {
  const msg = err?.message || '';
  const status = err?.status || err?.statusCode || 0;
  if (status === 429 || status >= 500) return true;
  if (/rate.?limit|overloaded|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(msg)) return true;
  return false;
}

function extractRetryDelayMs(err) {
  // Anthropic SDK: err.headers is a Headers or plain object
  // OpenAI SDK: err.headers is a plain object
  const headers = err?.headers || err?.error?.headers;
  if (headers) {
    const retryAfter = headers.get ? headers.get('retry-after') : headers['retry-after'];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
      const date = Date.parse(retryAfter);
      if (!isNaN(date)) return Math.max(date - Date.now(), 1000);
    }
  }
  return null;
}

export async function retryAsync(fn, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isRetryableError(err)) throw err;
      const retryAfterMs = extractRetryDelayMs(err);
      const delay = retryAfterMs != null
        ? Math.min(retryAfterMs + Math.random() * 500, 60000)
        : Math.min(BASE_DELAY_MS * 2 ** attempt + Math.random() * 500, 15000);
      log.warn(`[Retry] attempt=${attempt + 1}/${maxRetries} delay=${Math.round(delay)}ms${retryAfterMs != null ? ' (retry-after)' : ''} error=${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
