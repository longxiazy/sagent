const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|password|passwd|cookie|private[-_]?key|client[-_]?secret)/i;
// Token usage/count fields are observability metrics, not credentials. Keep this
// allowlist narrow so access_token, refresh_token, bearer_token, etc. remain redacted.
const TOKEN_METRIC_KEY = /^(?:prompt_tokens|completion_tokens|total_tokens|input_tokens|output_tokens|cached_tokens|reasoning_tokens|audio_tokens|accepted_prediction_tokens|rejected_prediction_tokens|prompt_tokens_details|completion_tokens_details|max_tokens|max_output_tokens|context_tokens|token_count|promptTokenCount|candidatesTokenCount|totalTokenCount|cachedContentTokenCount|maxOutputTokens|inputTokenLimit|outputTokenLimit)$/i;

function shouldRedactKey(key: string) {
  return SENSITIVE_KEY.test(key) && !TOKEN_METRIC_KEY.test(key);
}

function configuredSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redactText(value: unknown): string {
  let text = String(value ?? '');
  for (const secret of configuredSecrets()) {
    text = text.split(secret).join(REDACTED);
  }
  return text
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|nvapi|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/((?:authorization|api[-_]?key|token|secret|password|passwd|cookie|client[-_]?secret)["']?\s*[:=]\s*["']?)([^\s,"';&]+)/gi, `$1${REDACTED}`)
    .replace(/([?&](?:access_token|api_key|key|token|secret|password)=)([^&#\s]+)/gi, `$1${REDACTED}`);
}

export function redactSensitiveData<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return REDACTED as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item, seen)) as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = shouldRedactKey(key) && item != null
      ? REDACTED
      : redactSensitiveData(item, seen);
  }
  return output as T;
}
