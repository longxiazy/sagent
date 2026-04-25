import { log } from './logger.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryableError(err) {
  const msg = err?.message || '';
  const status = err?.status || err?.statusCode || 0;
  if (status === 429 || status >= 500) return true;
  if (/rate.?limit|overloaded|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(msg)) return true;
  return false;
}

export async function retryAsync(fn, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isRetryableError(err)) throw err;
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt + Math.random() * 500, 15000);
      log.warn(`[Retry] attempt=${attempt + 1}/${maxRetries} delay=${Math.round(delay)}ms error=${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
