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
