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
