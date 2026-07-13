import type { AgentAction } from './contracts.ts';

export type ToolFailureCategory =
  | 'transient'
  | 'rate_limit'
  | 'session'
  | 'authentication'
  | 'permission'
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'aborted'
  | 'unknown';

export type ToolFailureRecovery =
  | 'retry_same'
  | 'retry_later'
  | 'reconnect_then_retry'
  | 'revise_action'
  | 'request_permission'
  | 'switch_tool'
  | 'stop';

export type ToolFailure = {
  category: ToolFailureCategory;
  recovery: ToolFailureRecovery;
  retryable: boolean;
  source: string;
  confidence: number;
};

export type ToolFailureContext = {
  action: AgentAction;
  error: unknown;
  result?: unknown;
};

export type ToolFailureClassifier = (
  context: ToolFailureContext,
) => ToolFailure | null | Promise<ToolFailure | null>;

const classifiers: ToolFailureClassifier[] = [];

export function registerToolFailureClassifier(classifier: ToolFailureClassifier, { prepend = false } = {}) {
  if (prepend) classifiers.unshift(classifier);
  else classifiers.push(classifier);
  return () => {
    const index = classifiers.indexOf(classifier);
    if (index >= 0) classifiers.splice(index, 1);
  };
}

function textOf({ error, result }: ToolFailureContext) {
  const value = error || result || '';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const item: any = value;
    return [item.code, item.status, item.statusCode, item.name, item.message, item.error]
      .filter(Boolean)
      .join(' ');
  }
  return String(value);
}

function builtInClassifier(context: ToolFailureContext): ToolFailure | null {
  const text = textOf(context).toLowerCase();
  const error: any = context.error && typeof context.error === 'object' ? context.error : {};
  const code = String(error.code || '').toUpperCase();
  const status = Number(error.status || error.statusCode || 0);
  const match = (category: ToolFailureCategory, recovery: ToolFailureRecovery, retryable: boolean): ToolFailure => ({
    category,
    recovery,
    retryable,
    source: 'builtin',
    confidence: 0.9,
  });

  if (code === 'ABORT_ERR' || /aborted|已取消|取消执行/.test(text)) return match('aborted', 'stop', false);
  if (status === 429 || /rate.?limit|too many requests|配额|限流/.test(text)) return match('rate_limit', 'retry_later', true);
  if (code === 'BROWSER_SESSION_INVALID' || /connection closed|session.*(?:closed|invalid)|view is closed|会话.*(?:关闭|失效)|连接已关闭/.test(text)) {
    return match('session', 'reconnect_then_retry', true);
  }
  if (status === 401 || /unauthorized|invalid api key|authentication|认证失败|api key.*无效/.test(text)) {
    return match('authentication', 'stop', false);
  }
  if (status === 403 || /permission denied|not permitted|forbidden|未获批准|权限不足|拒绝访问/.test(text)) {
    return match('permission', 'request_permission', false);
  }
  if (status === 404 || code === 'ENOENT' || /not found|no such file|找不到|不存在/.test(text)) {
    return match('not_found', 'revise_action', false);
  }
  if (status === 409 || code === 'EEXIST' || /conflict|already exists|already running|冲突|已存在|正在运行/.test(text)) {
    return match('conflict', 'revise_action', false);
  }
  if (status === 400 || /invalid (?:argument|input|parameter)|missing required|参数.*(?:错误|缺失)|格式错误|解析失败/.test(text)) {
    return match('invalid_input', 'revise_action', false);
  }
  if (/not supported|unsupported|not available|unavailable|未启用|不可用|不支持|熔断/.test(text)) {
    return match('unavailable', 'switch_tool', false);
  }
  if (status >= 500 || /timeout|timed out|econnreset|econnrefused|etimedout|socket hang up|fetch failed|temporary|temporarily|超时|网络错误|临时失败/.test(text)) {
    return match('transient', 'retry_same', true);
  }
  return null;
}

export async function classifyToolFailure(context: ToolFailureContext): Promise<ToolFailure> {
  const structured: any = context.error && typeof context.error === 'object' ? context.error : null;
  const structuredRecovery = structured?.failureRecovery || structured?.recovery;
  if (structured?.failureCategory && structuredRecovery) {
    return {
      category: structured.failureCategory,
      recovery: structuredRecovery,
      retryable: Boolean(structured.retryable),
      source: 'structured',
      confidence: 1,
    };
  }

  for (const classifier of classifiers) {
    const classification = await classifier(context);
    if (classification) return classification;
  }

  return builtInClassifier(context) || {
    category: 'unknown',
    recovery: 'switch_tool',
    retryable: false,
    source: 'fallback',
    confidence: 0,
  };
}
