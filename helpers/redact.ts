const REDACTED = '[REDACTED]';
// 明确的凭据键（子串匹配）。注意不含裸 "token"：token 计数是可观测指标，
// 只有「凭据型 token 键」（见 isCredentialTokenKey）才脱敏。
const SENSITIVE_KEY = /(authorization|api[-_]?key|secret|password|passwd|cookie|private[-_]?key|client[-_]?secret)/i;

// 凭据型 token 键：单数 token 结尾（token、access_token、refresh-token、accessToken…）。
// 不匹配复数计数指标（*_tokens、tokens_per_second）或 token_count / promptTokenCount 等遥测字段。
function isCredentialTokenKey(key: string) {
  return /^token$/i.test(key) || /[_-]token$/i.test(key) || /[a-z]Token$/.test(key);
}

function shouldRedactKey(key: string) {
  return SENSITIVE_KEY.test(key) || isCredentialTokenKey(key);
}

function configuredSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => shouldRedactKey(key) && typeof value === 'string' && value.length >= 8)
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
  // seen 只跟踪「当前 DFS 路径上的祖先」以拦真正的循环引用；处理完子树后弹出，
  // 否则被多个兄弟字段共享的同一对象（如 response.usage 与顶层 usage）会被误当成环而整体脱敏。
  if (seen.has(value as object)) return REDACTED as T;
  seen.add(value as object);

  let output: unknown;
  if (Array.isArray(value)) {
    output = value.map(item => redactSensitiveData(item, seen));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      obj[key] = shouldRedactKey(key) && item != null
        ? REDACTED
        : redactSensitiveData(item, seen);
    }
    output = obj;
  }

  seen.delete(value as object);
  return output as T;
}
