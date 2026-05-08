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

export function createSession({
  id = generateSessionId(),
  messages = [],
  model,
  agentTrace = [],
  createdAt = Date.now(),
  updatedAt = Date.now(),
} = {}) {
  return {
    id,
    messages: normalizeMessages(messages),
    model: model || DEFAULT_MODEL_ID,
    agentTrace: Array.isArray(agentTrace) ? agentTrace : [],
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
            agentTrace: session.agentTrace,
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

export function useChatSessions() {
  const [chatState, setChatState] = useState(loadChatState);
  const { sessions, activeSessionId } = chatState;
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSession.id);
    localStorage.removeItem(LEGACY_MESSAGES_KEY);
    localStorage.removeItem(LEGACY_MODEL_KEY);
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
