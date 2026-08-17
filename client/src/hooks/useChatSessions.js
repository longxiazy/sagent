import { useCallback, useEffect, useRef, useState } from 'react';
import { tStatic } from '../i18n/locale.js';
import { normalizeAgentMeta } from '../utils/agent-stats.js';
import { apiFetch } from '../api/http.js';

// 单个会话保留的 Agent 执行记录上限。服务端 session-store 的 normalizeAgentRuns
// 也切在 30，两边必须一致，否则前端显示的条数会比落盘的多。
export const MAX_AGENT_RUN_HISTORY = 30;

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
  archivedAt = null,
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
    archivedAt: Number.isFinite(archivedAt) ? archivedAt : null,
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
            archivedAt: session.archivedAt,
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
  // 普通 run 的 trace 由服务端 JSONL 保存，并通过 /api/agent/traces/:runId 按需拉取；
  // chat-sessions.json 只保存消息/运行摘要，前端在需要时由 App.jsx 重新拉取 trace。
  // 隐私 run 不会写入上述两类文件，因此其 trace 只在当前内存状态中短暂存在。
  return sessions.map(session => {
    const agentRuns = stripAgentRunTraces(session.agentRuns);
    if ((session.agentTrace && session.agentTrace.length) || agentRuns !== session.agentRuns) {
      return { ...session, agentTrace: [], agentRuns };
    }
    return session;
  });
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    // 会话状态应始终是 JSON 可序列化的；如果未来加入非 JSON 字段，
    // 至少保留引用让页面继续可用，而不因为隐私清理导致崩溃。
    return value;
  }
}

function cloneChatState(state) {
  return {
    sessions: cloneJson(state.sessions),
    activeSessionId: state.activeSessionId,
  };
}

function cloneSyncedSessions(sessions) {
  return new Map([...sessions].map(([id, session]) => [id, cloneJson(session)]));
}

export function useChatSessions({ privateMode = false } = {}) {
  const privateModeEnabled = privateMode === true;
  const [chatState, setChatState] = useState(() => normalizeChatState({ sessions: [], activeSessionId: null }));
  const chatStateRef = useRef(chatState);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(null);
  const hydratedRef = useRef(false);
  const persistChainRef = useRef(Promise.resolve());
  // 上一次成功同步到后端的快照(id -> 已 strip 的会话)。diff 只针对本客户端自己
  // 见过的会话——因此过期客户端永远无法删除它从未见过的会话。
  const lastSyncedRef = useRef(new Map());
  // 隐私模式期间的会话只存在于内存。退出隐私模式时恢复进入前的快照，
  // 防止用户稍后切回普通模式时把隐私消息补写进 chat-sessions.json。
  const privateModeRef = useRef(privateModeEnabled);
  const initialPrivateModeRef = useRef(privateModeEnabled);
  const privateSnapshotRef = useRef(null);
  const restoringPrivateRef = useRef(false);
  const { sessions, activeSessionId } = chatState;
  const activeSession = sessions.find(session => session.id === activeSessionId) || sessions[0];

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  const preparePrivateMode = useCallback(() => {
    if (privateModeRef.current || !hydratedRef.current) return;
    // 某些入口（例如刷新后重连）会在同一批 React 更新里切换隐私模式并写入
    // 临时占位消息；必须在这些更新之前显式冻结普通会话快照，避免退出隐私
    // 模式时把占位消息当成“进入前状态”恢复并补写到后端。
    privateSnapshotRef.current = {
      chatState: cloneChatState(chatStateRef.current),
      lastSynced: cloneSyncedSessions(lastSyncedRef.current),
    };
    // 立即挡住 300ms debounce/串行队列中尚未发出的普通同步请求，不必等 effect 执行。
    privateModeRef.current = true;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/sessions', {
      signal: controller.signal,
      ...(initialPrivateModeRef.current ? { headers: { 'X-Private-Mode': 'true' } } : {}),
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        const next = normalizeChatState({
          sessions: data.sessions,
          activeSessionId: data.activeSessionId,
        });
        setChatState(next);
        lastSyncedRef.current = new Map(stripAgentTrace(next.sessions).map(session => [session.id, cloneJson(session)]));
        hydratedRef.current = true;
        if (privateModeRef.current) {
          privateSnapshotRef.current = {
            chatState: cloneChatState(next),
            lastSynced: cloneSyncedSessions(lastSyncedRef.current),
          };
        }
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
    const previous = privateModeRef.current;
    if (privateModeEnabled && !previous) {
      if (hydratedRef.current) {
        privateSnapshotRef.current = {
          chatState: cloneChatState(chatStateRef.current),
          lastSynced: cloneSyncedSessions(lastSyncedRef.current),
        };
      }
    } else if (!privateModeEnabled && previous) {
      const snapshot = privateSnapshotRef.current;
      privateSnapshotRef.current = null;
      if (snapshot) {
        // persistence effect 会在本轮看到这个标志并跳过一次，等待恢复后的
        // state 重新渲染；若进入隐私前还有普通模式未同步的改动，下一轮 diff
        // 仍会正常补写它们。
        restoringPrivateRef.current = true;
        lastSyncedRef.current = cloneSyncedSessions(snapshot.lastSynced);
        setChatState(snapshot.chatState);
      }
    }
    privateModeRef.current = privateModeEnabled;
  }, [privateModeEnabled]);

  // 只把“发生变化的那一条”同步到后端,永不推整份列表:
  //   - 新建 / 内容变化(updatedAt 改变) → 单条 PUT /api/sessions/:id
  //   - 从本客户端列表消失(仅永久删除会走这条) → 单条 DELETE /api/sessions/:id
  // diff 针对的是本客户端自己上一次同步的快照,而非后端存量,所以过期客户端
  // 绝不会误删它从未见过的会话——这正是历史上“整列表覆盖写”丢会话的根因。
  useEffect(() => {
    if (!hydratedRef.current) return undefined;
    if (privateModeEnabled) return undefined;
    if (restoringPrivateRef.current) {
      restoringPrivateRef.current = false;
      return undefined;
    }
    const current = stripAgentTrace(sessions);
    const currentById = new Map(current.map(session => [session.id, session]));
    const previous = lastSyncedRef.current;
    const upserts = current.filter(session => {
      const before = previous.get(session.id);
      return !before || before.updatedAt !== session.updatedAt;
    });
    const deletes = [...previous.values()].filter(session => !currentById.has(session.id));
    if (upserts.length === 0 && deletes.length === 0) return undefined;

    const timer = setTimeout(() => {
      persistChainRef.current = persistChainRef.current
        .catch(() => {})
        .then(async () => {
          // 模式可能在 300ms 延迟或串行队列等待期间切换；再次检查，
          // 避免已经排队的普通模式请求把隐私 state 发送出去。
          if (privateModeRef.current) return;
          for (const session of deletes) {
            if (privateModeRef.current) return;
            const query = session.projectId ? `?projectId=${encodeURIComponent(session.projectId)}` : '';
            const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}${query}`, {
              method: 'DELETE',
            });
            if (!response.ok && response.status !== 404) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || `HTTP ${response.status}`);
            }
          }
          for (const session of upserts) {
            if (privateModeRef.current) return;
            const response = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session }),
            });
            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || `HTTP ${response.status}`);
            }
          }
          if (privateModeRef.current) return;
          lastSyncedRef.current = currentById;
          setSessionsError(null);
        })
        .catch(err => {
          // 失败不更新快照,下次 diff 会自动重试。
          console.warn('[useChatSessions] backend persistence failed', err);
          setSessionsError(err?.message || String(err));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [privateModeEnabled, sessions]);

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
    preparePrivateMode,
    sessionsLoading,
    sessionsError,
  };
}
