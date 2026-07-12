import { useCallback, useEffect, useRef, useState } from 'react';
import { tStatic } from '../i18n/locale.js';
import { normalizeAgentMeta } from '../utils/agent-stats.js';
import { apiFetch } from '../api/http.js';

const MAX_AGENT_RUN_HISTORY = 30;

function generateSessionId() {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({
      role: item.role,
      content: item.content,
      ...(item.ts ? { ts: item.ts } : {}),
      ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
      ...(Array.isArray(item.modelsUsed) ? { modelsUsed: normalizeModelIds(item.modelsUsed) } : {}),
      ...(item.pending ? { pending: item.pending } : {}),
    }));
}

function normalizeModelIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()))];
}

function normalizeModelId(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function traceRunId(trace) {
  if (!Array.isArray(trace)) {
    return null;
  }

  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const runId = normalizeModelId(trace[i]?.runId);
    if (runId) return runId;
  }
  return null;
}

function agentRunKey(run) {
  return run?.runId || `${run?.meta?.startedAt || ''}:${run?.meta?.endedAt || ''}:${run?.meta?.task || ''}`;
}

function normalizeAgentRun(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const trace = Array.isArray(value.trace) ? value.trace : [];
  const meta = normalizeAgentMeta(value.meta);
  const runId = normalizeModelId(value.runId) || meta?.runId || traceRunId(trace);

  if (!runId && !meta && trace.length === 0) {
    return null;
  }

  return {
    runId,
    trace,
    meta,
  };
}

function normalizeAgentRuns(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const runs = [];
  for (const item of value) {
    const run = normalizeAgentRun(item);
    if (!run) continue;
    const key = agentRunKey(run);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    runs.push(run);
  }
  return runs.slice(0, MAX_AGENT_RUN_HISTORY);
}

export function createSession({
  id = generateSessionId(),
  messages = [],
  model,
  modelsUsed = [],
  agentTrace = [],
  agentRunId = null,
  agentMeta = null,
  agentRuns = [],
  projectId = null,
  createdAt = Date.now(),
  updatedAt = Date.now(),
} = {}) {
  return {
    id,
    messages: normalizeMessages(messages),
    model: normalizeModelId(model),
    modelsUsed: normalizeModelIds(modelsUsed),
    agentTrace: Array.isArray(agentTrace) ? agentTrace : [],
    agentRunId: typeof agentRunId === 'string' ? agentRunId : null,
    agentMeta: normalizeAgentMeta(agentMeta),
    agentRuns: normalizeAgentRuns(agentRuns),
    // 会话归属的项目；null = 无项目（全局态，向后兼容旧会话）。
    projectId: typeof projectId === 'string' && projectId ? projectId : null,
    createdAt,
    updatedAt,
  };
}

export function upsertAgentRun(session, runInput = {}) {
  const run = normalizeAgentRun(runInput);
  if (!session || !run) {
    return session;
  }

  const key = agentRunKey(run);
  const existingRuns = normalizeAgentRuns(session.agentRuns);
  const nextRuns = [
    run,
    ...existingRuns.filter(item => agentRunKey(item) !== key),
  ];

  return {
    ...session,
    agentRuns: normalizeAgentRuns(nextRuns),
  };
}

export function normalizeChatState(rawState) {
  const sessions = Array.isArray(rawState?.sessions)
    ? rawState.sessions
        .map(session => {
          if (!session || typeof session !== 'object') {
            return null;
          }

          return createSession({
            id: typeof session.id === 'string' && session.id ? session.id : undefined,
            messages: session.messages,
            model: session.model,
            modelsUsed: session.modelsUsed,
            agentTrace: session.agentTrace,
            agentRunId: session.agentRunId,
            agentMeta: session.agentMeta,
            agentRuns: session.agentRuns,
            projectId: session.projectId,
            createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
            updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : Date.now(),
          });
        })
        .filter(Boolean)
    : [];

  const nextSessions = sessions.length > 0 ? sessions : [createSession()];
  const activeSessionId = nextSessions.some(session => session.id === rawState?.activeSessionId)
    ? rawState.activeSessionId
    : nextSessions[0].id;

  return { sessions: nextSessions, activeSessionId };
}

export function touchSession(session, patch = {}) {
  return {
    ...session,
    ...patch,
    updatedAt: Date.now(),
  };
}

export function getSessionTitle(messages) {
  const firstUserMessage = messages.find(item => item.role === 'user' && item.content.trim());
  if (!firstUserMessage) {
    return tStatic('session.newChat');
  }

  const text = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function stripAgentRunTraces(agentRuns) {
  return normalizeAgentRuns(agentRuns).map(run => (
    run.trace && run.trace.length > 0
      ? { ...run, trace: [] }
      : run
  ));
}

function stripAgentTrace(sessions) {
  // agentTrace 是 SSE 事件流的客户端镜像，单个 run 可达几 MB。
  // 服务端已经在 data/traces/<runId>.jsonl 全量落盘，并通过 /api/agent/traces/:runId 提供按需拉取，
  // localStorage 只需要保存 agentRunId，刷新后由 App.jsx 的 useEffect 触发拉取重建。
  return sessions.map(session => {
    const agentRuns = stripAgentRunTraces(session.agentRuns);
    if ((session.agentTrace && session.agentTrace.length) || agentRuns !== session.agentRuns) {
      return { ...session, agentTrace: [], agentRuns };
    }
    return session;
  });
}

export function useChatSessions() {
  const [chatState, setChatState] = useState(() => normalizeChatState({ sessions: [], activeSessionId: null }));
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(null);
  const hydratedRef = useRef(false);
  const persistChainRef = useRef(Promise.resolve());
  const { sessions, activeSessionId } = chatState;
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/sessions', { signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setChatState(normalizeChatState({
          sessions: data.sessions,
          activeSessionId: data.activeSessionId,
        }));
        hydratedRef.current = true;
        setSessionsError(null);
        setSessionsLoading(false);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setSessionsError(err?.message || String(err));
        setSessionsLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return undefined;
    const payload = {
      sessions: stripAgentTrace(sessions),
      activeSessionId: activeSession.id,
    };
    const timer = setTimeout(() => {
      persistChainRef.current = persistChainRef.current
        .catch(() => {})
        .then(async () => {
          const response = await apiFetch('/api/sessions', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${response.status}`);
          }
        })
        .catch(err => {
          console.warn('[useChatSessions] backend persistence failed', err);
          setSessionsError(err?.message || String(err));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [activeSession.id, sessions]);

  const updateSession = useCallback((sessionId, updater) => {
    setChatState(prev =>
      normalizeChatState({
        ...prev,
        sessions: prev.sessions.map(session => (session.id === sessionId ? updater(session) : session)),
      })
    );
  }, []);

  return {
    chatState,
    setChatState,
    sessions,
    activeSession,
    messages: activeSession.messages,
    updateSession,
    sessionsLoading,
    sessionsError,
  };
}
