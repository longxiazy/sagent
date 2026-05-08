import { log } from './logger.ts';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BASE_MS = 30000;

function isRetryableError(err) {
  const msg = err?.message || '';
  const status = err?.status || err?.statusCode || 0;
  if (status === 429 || status >= 500) return true;
  if (/rate.?limit|overloaded|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(msg)) return true;
  return false;
}

function isRateLimitError(err) {
  const status = err?.status || err?.statusCode || 0;
  return status === 429;
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
      const is429 = isRateLimitError(err);
      const base = retryAfterMs != null
        ? retryAfterMs
        : is429 ? RATE_LIMIT_BASE_MS : BASE_DELAY_MS;
      const cap = is429 ? 60000 : 15000;
      const delay = Math.min(base * 2 ** attempt + Math.random() * 500, cap);
      log.warn(`[Retry] attempt=${attempt + 1}/${maxRetries} delay=${Math.round(delay)}ms${retryAfterMs != null ? ' (retry-after)' : is429 ? ' (429-backoff)' : ''} error=${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
