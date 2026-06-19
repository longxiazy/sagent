import { log } from './logger.ts';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BASE_MS = 30000;

function pickHeader(headers, name) {
  if (!headers) return undefined;
  return headers.get ? headers.get(name) : headers[name] || headers[name.toLowerCase()];
}

function extractHeaders(err) {
  const headers = err?.headers || err?.error?.headers;
  const result = {};
  for (const name of ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-remaining', 'x-request-id']) {
    const value = pickHeader(headers, name);
    if (value != null) result[name] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

export function extractErrorDiagnostics(err) {
  const cause = err?.cause;
  const diagnostics = {
    name: err?.name,
    message: err?.message,
    status: err?.status,
    statusCode: err?.statusCode,
    code: err?.code,
    type: err?.type,
    request_id: err?.request_id || err?.requestID,
    headers: extractHeaders(err),
    cause: cause ? {
      name: cause.name,
      message: cause.message,
      code: cause.code,
      errno: cause.errno,
      syscall: cause.syscall,
      hostname: cause.hostname,
      host: cause.host,
      port: cause.port,
    } : undefined,
  };
  return Object.fromEntries(Object.entries(diagnostics).filter(([, value]) => value !== undefined));
}

export function formatErrorDiagnostics(err) {
  const d = extractErrorDiagnostics(err);
  const parts = [];
  for (const key of ['name', 'status', 'statusCode', 'code', 'type', 'request_id']) {
    if (d[key] != null) parts.push(`${key}=${d[key]}`);
  }
  if (d.cause) {
    for (const key of ['name', 'code', 'errno', 'syscall', 'hostname', 'host', 'port']) {
      if (d.cause[key] != null) parts.push(`cause.${key}=${d.cause[key]}`);
    }
  }
  return parts.length ? `${d.message || 'Error'} (${parts.join(' ')})` : (d.message || String(err));
}

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

export async function retryAsync(fn, maxRetries = MAX_RETRIES, context = {}, options: { retryRateLimit?: boolean } = {}) {
  const { retryRateLimit = true } = options;
  const contextText = Object.keys(context).length ? ` context=${JSON.stringify(context)}` : '';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      // 默认会重试 429 限流。但带单步超时的调用（如 agentPlan）会传 retryRateLimit=false：
      // 让 429 立即上抛，交由 planner 层处理（展示真实配额错误 + 冷却/降级）。
      // 否则这里的长退避（30~60s × 多次）会撑满模型超时，把“配额超限”掩盖成“模型超时”。
      const rateLimitedNoRetry = !retryRateLimit && isRateLimitError(err);
      if (attempt === maxRetries || !isRetryableError(err) || rateLimitedNoRetry) {
        log.warn(`[Retry] final failure${contextText} error=${formatErrorDiagnostics(err)}`);
        throw err;
      }
      const retryAfterMs = extractRetryDelayMs(err);
      const is429 = isRateLimitError(err);
      const base = retryAfterMs != null
        ? retryAfterMs
        : is429 ? RATE_LIMIT_BASE_MS : BASE_DELAY_MS;
      const cap = is429 ? 60000 : 15000;
      const delay = Math.min(base * 2 ** attempt + Math.random() * 500, cap);
      log.warn(`[Retry] attempt=${attempt + 1}/${maxRetries} delay=${Math.round(delay)}ms${retryAfterMs != null ? ' (retry-after)' : is429 ? ' (429-backoff)' : ''}${contextText} error=${formatErrorDiagnostics(err)}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
