import { computeTraceMetrics } from '../components/agent/trace-metrics.js';

function uniqueModelIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()))];
}

function finiteNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function eventTime(event) {
  const candidates = [event?.end_time, event?.timestamp, event?.time, event?.ts];
  for (const value of candidates) {
    if (Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function eventTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
}

function traceModels(trace) {
  if (!Array.isArray(trace)) return [];
  const planned = trace.flatMap(event => {
    if (event?.type !== 'model_plan') return [];
    return event.model ? [event.model] : event.models;
  });

  let used = [];
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const models = uniqueModelIds(trace[i]?.meta?.models_used);
    if (models.length > 0) {
      used = models;
      break;
    }
  }

  return uniqueModelIds([...used, ...planned]);
}

function traceStrategy(trace) {
  if (!Array.isArray(trace)) return null;
  const startEvent = trace.find(event => event?.type === 'model_plan' && event.stage === 'start' && event.strategy);
  return typeof startEvent?.strategy === 'string' ? startEvent.strategy : null;
}

function traceRunId(trace) {
  if (!Array.isArray(trace)) return null;
  const event = trace.find(item => typeof item?.runId === 'string' && item.runId);
  return event?.runId || null;
}

function traceRunMeta(trace) {
  if (!Array.isArray(trace)) return null;
  return trace.find(event => event?.type === 'run_meta') || null;
}

function traceTerminal(trace) {
  if (!Array.isArray(trace)) return null;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i]?.type === 'done' || trace[i]?.type === 'error') {
      return trace[i];
    }
  }
  return null;
}

function firstTraceTime(trace) {
  if (!Array.isArray(trace)) return null;
  let first = null;
  for (const event of trace) {
    const ts = eventTime(event);
    if (ts == null) continue;
    first = first == null ? ts : Math.min(first, ts);
  }
  return first;
}

function lastMessageTime(messages, role = null) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (role && message?.role !== role) continue;
    if (Number.isFinite(message?.ts)) return message.ts;
  }
  return null;
}

function lastUserTask(messages) {
  if (!Array.isArray(messages)) return '';
  const message = [...messages].reverse().find(item => item?.role === 'user' && item.content?.trim());
  return message?.content?.trim() || '';
}

function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function modelUsageTokens(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(modelUsage)) {
    if (Number.isFinite(value)) continue;
    total += eventTokens(value);
  }
  return total;
}

export function normalizeAgentMeta(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const models = uniqueModelIds(value.models);
  const task = typeof value.task === 'string' ? value.task.trim() : '';
  const status = typeof value.status === 'string' && value.status.trim() ? value.status : null;
  const strategy = typeof value.strategy === 'string' && value.strategy.trim() ? value.strategy : null;
  const runId = typeof value.runId === 'string' && value.runId.trim() ? value.runId : null;

  if (!task && !status && !runId && models.length === 0) {
    return null;
  }

  return {
    task,
    startedAt: finiteNumber(value.startedAt),
    endedAt: finiteNumber(value.endedAt),
    elapsedMs: Math.max(0, finiteNumber(value.elapsedMs, 0)),
    totalTokens: Math.max(0, Math.round(finiteNumber(value.totalTokens, 0))),
    stepCount: Math.max(0, Math.round(finiteNumber(value.stepCount, 0))),
    models,
    strategy,
    status,
    runId,
  };
}

export function buildAgentMetaFromSession(session, traceInput, overrides = {}) {
  if (!session || typeof session !== 'object') {
    return null;
  }

  const trace = Array.isArray(traceInput) ? traceInput : (Array.isArray(session.agentTrace) ? session.agentTrace : []);
  const stored = normalizeAgentMeta(session.agentMeta);
  const terminal = traceTerminal(trace);
  const doneMeta = terminal?.type === 'done' ? (terminal.meta || {}) : {};
  const metrics = trace.length > 0 ? computeTraceMetrics(trace) : null;
  const metaTokens = modelUsageTokens(doneMeta.model_usage);
  const terminalStatus = terminal?.type === 'error'
    ? (terminal.error === 'Agent 已取消' ? 'cancelled' : 'error')
    : terminal?.quality?.status || doneMeta.status || null;
  const models = uniqueModelIds([
    ...uniqueModelIds(overrides.models),
    ...traceModels(trace),
    ...uniqueModelIds(doneMeta.models_used),
    ...(stored?.models || []),
    ...uniqueModelIds(session.modelsUsed),
    ...(session.model ? [session.model] : []),
  ]);
  const startedAt = finiteNumber(overrides.startedAt)
    ?? stored?.startedAt
    ?? finiteNumber(traceRunMeta(trace)?.startedAt)
    ?? lastMessageTime(session.messages, 'user')
    ?? firstTraceTime(trace)
    ?? finiteNumber(session.createdAt);
  const endedAt = finiteNumber(overrides.endedAt)
    ?? eventTime(terminal)
    ?? stored?.endedAt
    ?? lastMessageTime(session.messages, 'assistant')
    ?? finiteNumber(session.updatedAt)
    ?? startedAt;
  const elapsedMs = finiteNumber(overrides.elapsedMs)
    ?? finiteNumber(doneMeta.elapsed_ms)
    ?? (metrics?.totalDurationMs && metrics.totalDurationMs > 0 ? metrics.totalDurationMs : null)
    ?? (startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null)
    ?? stored?.elapsedMs
    ?? 0;
  const totalTokens = finiteNumber(overrides.totalTokens)
    ?? (metrics?.totalTokens && metrics.totalTokens > 0 ? metrics.totalTokens : null)
    ?? (metaTokens > 0 ? metaTokens : null)
    ?? stored?.totalTokens
    ?? 0;
  const stepCount = finiteNumber(overrides.stepCount)
    ?? finiteNumber(doneMeta.step_count)
    ?? (metrics?.stepCount && metrics.stepCount > 0 ? metrics.stepCount : null)
    ?? stored?.stepCount
    ?? 0;
  const status = (typeof overrides.status === 'string' && overrides.status)
    || terminalStatus
    || stored?.status
    || null;
  const task = (typeof overrides.task === 'string' && overrides.task.trim())
    || stored?.task
    || lastUserTask(session.messages)
    || traceRunMeta(trace)?.task
    || '';
  const strategy = (typeof overrides.strategy === 'string' && overrides.strategy.trim())
    || traceStrategy(trace)
    || stored?.strategy
    || (models.length > 1 ? 'race' : 'race');
  const runId = (typeof overrides.runId === 'string' && overrides.runId.trim())
    || session.agentRunId
    || stored?.runId
    || traceRunId(trace)
    || null;

  if (!status && !stored && !terminal) {
    return null;
  }

  return normalizeAgentMeta({
    task,
    startedAt,
    endedAt,
    elapsedMs,
    totalTokens,
    stepCount,
    models,
    strategy,
    status,
    runId,
  });
}

export function buildAgentStats(sessions, { now = Date.now(), days = 7 } = {}) {
  const records = (Array.isArray(sessions) ? sessions : [])
    .map(session => {
      const meta = buildAgentMetaFromSession(session);
      return meta ? { ...meta, sessionId: session.id } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));

  const todayStart = startOfDay(now);
  const tomorrowStart = todayStart + 86400000;
  const todayRuns = records.filter(item => {
    const ts = item.startedAt ?? item.endedAt;
    return ts != null && ts >= todayStart && ts < tomorrowStart;
  });
  const allModels = new Set(records.flatMap(item => item.models));
  const todayModels = new Set(todayRuns.flatMap(item => item.models));
  const dayBuckets = new Map();

  for (let i = days - 1; i >= 0; i -= 1) {
    const ts = todayStart - i * 86400000;
    const key = dayKey(ts);
    dayBuckets.set(key, { date: key, tokens: 0, runs: 0, elapsedMs: 0 });
  }

  for (const item of records) {
    const ts = item.startedAt ?? item.endedAt;
    const key = ts != null ? dayKey(ts) : '';
    const bucket = dayBuckets.get(key);
    if (!bucket) continue;
    bucket.tokens += item.totalTokens || 0;
    bucket.runs += 1;
    bucket.elapsedMs += item.elapsedMs || 0;
  }

  return {
    records,
    totalRuns: records.length,
    todayRuns: todayRuns.length,
    totalTokens: records.reduce((sum, item) => sum + (item.totalTokens || 0), 0),
    todayTokens: todayRuns.reduce((sum, item) => sum + (item.totalTokens || 0), 0),
    totalElapsedMs: records.reduce((sum, item) => sum + (item.elapsedMs || 0), 0),
    todayElapsedMs: todayRuns.reduce((sum, item) => sum + (item.elapsedMs || 0), 0),
    modelCount: allModels.size,
    todayModelCount: todayModels.size,
    recentRuns: records.slice(0, 5),
    dailyData: [...dayBuckets.values()],
  };
}
