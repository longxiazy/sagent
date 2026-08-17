function compactChunk(value) {
  return String(value || '').slice(0, 120);
}

export function agentTraceEventKey(event) {
  if (!event || typeof event !== 'object') return '';

  if (Number.isFinite(event.seq)) {
    return `${event.runId || ''}:seq:${event.seq}`;
  }

  if (event.type === 'terminal_output') {
    const seq = event.sequence ?? event.seq ?? null;
    if (seq != null) {
      return `${event.type}:${event.step ?? ''}:${seq}`;
    }
    return [
      event.type,
      event.step ?? '',
      event.phase ?? '',
      event.elapsedMs ?? '',
      event.exitCode ?? '',
      compactChunk(event.chunk || event.message || ''),
    ].join(':');
  }

  if (event.type === 'mcp_output') {
    return `${event.type}:${event.step ?? ''}:${event.sequence ?? event.phase}:${compactChunk(event.message || '')}`;
  }

  return `${event.type}:${event.step ?? ''}:${event.stage ?? ''}:${event.model ?? ''}`;
}

export function appendUniqueTraceEvent(prev, event) {
  const key = agentTraceEventKey(event);
  if (key && prev.some(existing => agentTraceEventKey(existing) === key)) {
    return prev;
  }
  return [...prev, event];
}

// 整条 trace 一次性落地时(切换会话、SSE 重连回放)的批量去重。
// appendUniqueTraceEvent 是为“逐个追加”写的：每追加一个事件都要重算一遍已有事件的
// key 并复制整份数组，拿它 reduce 一条几百事件的 trace 就是 O(n²)，这笔开销全压在
// 切会话那一帧上。语义保持一致：同 key 留先出现的那个，算不出 key 的事件一律保留。
export function dedupeTraceEvents(events) {
  if (!Array.isArray(events)) return [];

  const seen = new Set();
  const result = [];
  for (const event of events) {
    const key = agentTraceEventKey(event);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(event);
  }
  return result;
}

// 从 checkpoint 重跑会复用 runId，于是同一条 trace 里留着每个 attempt 的
// done/error。取首个会读到早已被重跑覆盖的旧结果——成功的 run 因此被记成失败。
// 语义上“这个 run 的结局”永远是最后一个终止事件。
export function latestTerminalEvent(events) {
  if (!Array.isArray(events)) return null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i]?.type;
    if (type === 'done' || type === 'error') return events[i];
  }
  return null;
}

function attemptOf(event) {
  const attempt = Number(event?.attempt);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
}

/**
 * 「这个 run 已经结束了吗」——只认属于最新一次 attempt 的终止事件。
 *
 * latestTerminalEvent 单看是不够的：重跑到一半时，trace 里最后一个终止事件
 * 还是上一次 attempt 的失败，拿它当结局会在任务正跑着的时候报失败、把运行态
 * 清掉，连带清掉待审批/待提问，而后端仍在继续执行。
 * 新 attempt 一开跑就会追加更高 attempt 的事件，故以本批事件的最大 attempt 为界。
 * 老 trace 没有 attempt 字段时统一按 1 处理，行为与加守卫前一致。
 */
export function settledTerminalEvent(events) {
  const terminal = latestTerminalEvent(events);
  if (!terminal) return null;

  const maxAttempt = events.reduce((max, event) => Math.max(max, attemptOf(event)), 1);
  return attemptOf(terminal) < maxAttempt ? null : terminal;
}
