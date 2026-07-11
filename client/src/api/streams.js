import { tStatic } from '../i18n/locale.js';
import { apiFetch } from './http.js';

const AGENT_API_URL = '/api/agent';
const AGENT_APPROVAL_API_URL = '/api/agent/approvals';

async function streamSseJson({ url, body, signal, onEvent }) {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    try {
      const parsed = JSON.parse(errorText);
      throw new Error(parsed.error || `HTTP ${res.status}`);
    } catch (parseErr) {
      if (parseErr.message && !parseErr.message.startsWith('HTTP')) throw parseErr;
      throw new Error(errorText || `HTTP ${res.status}`);
    }
  }

  if (!res.body) {
    throw new Error(tStatic('api.streamUnavailable'));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = async rawEvent => {
    const line = rawEvent
      .split('\n')
      .map(item => item.trim())
      .find(item => item.startsWith('data: '));

    if (!line) {
      return;
    }

    const json = JSON.parse(line.slice(6));
    if (json.error && !json.type) {
      throw new Error(json.error);
    }
    await onEvent?.(json);
  };

  const flushBuffer = async final => {
    const events = buffer.split('\n\n');
    buffer = final ? '' : events.pop() ?? '';
    for (const rawEvent of events) {
      if (rawEvent.trim()) {
        await handleEvent(rawEvent);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    await flushBuffer(false);
  }

  buffer += decoder.decode();
  await flushBuffer(true);
}

export async function streamAgentRun({ task, model, models, strategy, memory, signal, onEvent, messages, ...extra }) {
  let runId = null;
  let gotDone = false;
  let initialError = null;
  let lastSeq = 0;

  const wrappedEvent = event => {
    if (event.runId) runId = event.runId;
    if (Number.isFinite(event.seq)) lastSeq = Math.max(lastSeq, event.seq);
    if (event.type === 'done' || event.type === 'error') gotDone = true;
    onEvent(event);
  };

  try {
    await streamSseJson({
      url: AGENT_API_URL,
      body: { task, model, models, strategy, memory, messages, ...extra },
      signal,
      onEvent: wrappedEvent,
    });
  } catch (err) {
    initialError = err;
    // initial POST may fail/disconnect, fall through to reconnect
  }

  if (!gotDone && runId && !signal.aborted) {
    try {
      const params = new URLSearchParams();
      if (lastSeq > 0) params.set('cursor', String(lastSeq));
      if (extra.projectId) params.set('projectId', extra.projectId);
      const query = params.toString();
      const res = await apiFetch(`/api/agent/stream/${encodeURIComponent(runId)}${query ? `?${query}` : ''}`, { signal });
      if (!res.ok) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const dataLine = line.replace(/^data:\s*/, '');
          if (!dataLine || dataLine === '[DONE]') continue;
          try {
            const event = JSON.parse(dataLine);
            wrappedEvent(event);
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      // reconnect also failed
    }
  }

  if (!gotDone && initialError) {
    throw initialError;
  }
}

export async function submitAgentApproval({ runId, approvalId, decision }) {
  const res = await apiFetch(AGENT_APPROVAL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, approvalId, decision }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function submitAgentQuestion({ runId, approvalId, response }) {
  const res = await apiFetch('/api/agent/question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, approvalId, response }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function fetchAgentTrace(runId, { signal, projectId } = {}) {
  if (!runId) return [];

  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const res = await apiFetch(`/api/agent/traces/${encodeURIComponent(runId)}${qs}`, { signal });
  if (res.status === 404) return [];
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data.events) ? data.events : [];
}
