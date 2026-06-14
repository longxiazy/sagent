import { useCallback, useEffect, useState } from 'react';

const DEFAULT_MODEL_ID = 'minimaxai/minimax-m2.7';

const LEGACY_MESSAGES_KEY = 'nvidia_chat_messages';
const LEGACY_MODEL_KEY = 'nvidia_chat_model';
const SESSIONS_KEY = 'nvidia_chat_sessions';
const ACTIVE_SESSION_KEY = 'nvidia_chat_active_session';

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
    }));
}

function normalizeModelIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()))];
}

export function createSession({
  id = generateSessionId(),
  messages = [],
  model,
  modelsUsed = [],
  agentTrace = [],
  agentRunId = null,
  createdAt = Date.now(),
  updatedAt = Date.now(),
} = {}) {
  return {
    id,
    messages: normalizeMessages(messages),
    model: model || DEFAULT_MODEL_ID,
    modelsUsed: normalizeModelIds(modelsUsed),
    agentTrace: Array.isArray(agentTrace) ? agentTrace : [],
    agentRunId: typeof agentRunId === 'string' ? agentRunId : null,
    createdAt,
    updatedAt,
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

function loadChatState() {
  try {
    const storedSessions = JSON.parse(localStorage.getItem(SESSIONS_KEY) || 'null');
    if (Array.isArray(storedSessions) && storedSessions.length > 0) {
      return normalizeChatState({
        sessions: storedSessions,
        activeSessionId: localStorage.getItem(ACTIVE_SESSION_KEY),
      });
    }
  } catch {
    // ignore malformed storage and fall back to migration/default state
  }

  let legacyMessages = [];
  try {
    legacyMessages = JSON.parse(localStorage.getItem(LEGACY_MESSAGES_KEY) || '[]');
  } catch {
    legacyMessages = [];
  }

  const migratedSession = createSession({
    messages: legacyMessages,
    model: localStorage.getItem(LEGACY_MODEL_KEY) || DEFAULT_MODEL_ID,
  });

  return normalizeChatState({
    sessions: [migratedSession],
    activeSessionId: migratedSession.id,
  });
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
    return '新对话';
  }

  const text = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function isQuotaError(err) {
  // 浏览器之间 name/code 不一致，这里多覆盖几种。
  if (!err) return false;
  return err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err.code === 22
    || err.code === 1014;
}

function stripAgentTrace(sessions) {
  // agentTrace 是 SSE 事件流的客户端镜像，单个 run 可达几 MB。
  // 服务端已经在 data/traces/<runId>.jsonl 全量落盘，并通过 /api/agent/traces/:runId 提供按需拉取，
  // localStorage 只需要保存 agentRunId，刷新后由 App.jsx 的 useEffect 触发拉取重建。
  return sessions.map(session => (
    session.agentTrace && session.agentTrace.length
      ? { ...session, agentTrace: [] }
      : session
  ));
}

function persistSessions(sessions) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(stripAgentTrace(sessions)));
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    // 已经只存元数据还撞配额，说明会话条数太多；保留最近 20 条试一次再吞错。
    try {
      const trimmed = stripAgentTrace(sessions)
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20);
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(trimmed));
    } catch (err2) {
      if (!isQuotaError(err2)) throw err2;
      console.warn('[useChatSessions] localStorage quota exceeded, sessions not persisted', err2);
    }
  }
}

export function useChatSessions() {
  const [chatState, setChatState] = useState(loadChatState);
  const { sessions, activeSessionId } = chatState;
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];

  useEffect(() => {
    persistSessions(sessions);
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeSession.id);
      localStorage.removeItem(LEGACY_MESSAGES_KEY);
      localStorage.removeItem(LEGACY_MODEL_KEY);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
    }
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
    chatModel: activeSession.model,
    updateSession,
  };
}
