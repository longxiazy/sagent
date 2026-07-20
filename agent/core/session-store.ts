import fs from 'node:fs/promises';
import path from 'node:path';
import { createPersistenceQueue } from '../../helpers/persistence-queue.ts';
import { listTraceRuns, readTraceEvents } from '../../helpers/trace-store.ts';
import { projectDataDir, type ProjectStore } from './project-store.ts';

const SESSIONS_FILE = 'chat-sessions.json';
const SESSION_VERSION = 1;

type StoredSession = Record<string, any>;

interface ScopeState {
  version: number;
  activeSessionId: string | null;
  sessions: StoredSession[];
  dismissedTraceRunIds: string[];
  skippedTraceRunIds: string[];
  updatedAt: string;
}

interface RunLogEntry {
  task: string;
  model: string | null;
  startedAt: number | null;
}

function sessionFile(dataDir: string) {
  return path.join(dataDir, SESSIONS_FILE);
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function finiteNumber(value: unknown, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function isActiveSession(session: StoredSession) {
  return !session.archivedAt;
}

function generateSessionId() {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(message => message && typeof message === 'object')
    .filter((message: any) => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map((message: any) => ({
      role: message.role,
      content: message.content,
      ...(Number.isFinite(message.ts) ? { ts: Number(message.ts) } : {}),
      ...(typeof message.model === 'string' && message.model.trim() ? { model: message.model.trim() } : {}),
      ...(uniqueStrings(message.modelsUsed).length > 0 ? { modelsUsed: uniqueStrings(message.modelsUsed) } : {}),
      ...(typeof message.pending === 'string' && message.pending ? { pending: message.pending } : {}),
    }));
}

function normalizeAgentRuns(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const runs = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const runId = typeof item.runId === 'string' && item.runId ? item.runId : null;
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    runs.push({ runId, trace: [], meta: item.meta && typeof item.meta === 'object' ? item.meta : null });
  }
  return runs.slice(0, 30);
}

function normalizeSession(value: unknown, projectId: string | null): StoredSession | null {
  if (!value || typeof value !== 'object') return null;
  const session: any = value;
  const now = Date.now();
  const id = typeof session.id === 'string' && session.id.trim() ? session.id.trim() : generateSessionId();
  const model = typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null;
  const agentRunId = typeof session.agentRunId === 'string' && session.agentRunId ? session.agentRunId : null;
  return {
    id,
    messages: normalizeMessages(session.messages),
    model,
    modelsUsed: uniqueStrings(session.modelsUsed),
    agentTrace: [],
    agentRunId,
    agentMeta: session.agentMeta && typeof session.agentMeta === 'object' ? session.agentMeta : null,
    agentRuns: normalizeAgentRuns(session.agentRuns),
    projectId,
    archivedAt: Number.isFinite(session.archivedAt) ? Number(session.archivedAt) : null,
    createdAt: finiteNumber(session.createdAt, now),
    updatedAt: finiteNumber(session.updatedAt, now),
  };
}

function emptyScopeState(): ScopeState {
  return {
    version: SESSION_VERSION,
    activeSessionId: null,
    sessions: [],
    dismissedTraceRunIds: [],
    skippedTraceRunIds: [],
    updatedAt: new Date(0).toISOString(),
  };
}

async function readScopeState(dataDir: string, projectId: string | null): Promise<ScopeState> {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionFile(dataDir), 'utf8'));
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.map((session: unknown) => normalizeSession(session, projectId)).filter(Boolean) as StoredSession[]
      : [];
    const activeSessionId = sessions.some(session => session.id === parsed.activeSessionId && isActiveSession(session))
      ? parsed.activeSessionId
      : sessions.find(isActiveSession)?.id || null;
    return {
      version: SESSION_VERSION,
      activeSessionId,
      sessions,
      dismissedTraceRunIds: uniqueStrings(parsed.dismissedTraceRunIds),
      skippedTraceRunIds: uniqueStrings(parsed.skippedTraceRunIds),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return emptyScopeState();
  }
}

async function writeScopeState(dataDir: string, state: ScopeState) {
  await fs.mkdir(dataDir, { recursive: true });
  const target = sessionFile(dataDir);
  const tmp = `${target}.tmp`;
  const next = { ...state, version: SESSION_VERSION, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

function sessionRunIds(session: StoredSession) {
  return uniqueStrings([
    session.agentRunId,
    ...(Array.isArray(session.agentRuns) ? session.agentRuns.map((run: any) => run?.runId) : []),
  ]);
}

function eventTime(event: any) {
  for (const value of [event?.timestamp, event?.end_time, event?.start_time, event?.time, event?.ts]) {
    if (Number.isFinite(value)) return Number(value);
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function lastEvent(events: any[], predicate: (event: any) => boolean) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

async function loadRunLogIndex(memoryDir: string) {
  const index = new Map<string, RunLogEntry>();
  const logsDir = path.join(memoryDir, 'logs');
  let files: string[] = [];
  try {
    files = (await fs.readdir(logsDir)).filter(file => file.endsWith('.log')).sort();
  } catch {
    return index;
  }

  const pattern = /^\[([^\]]+)\s+INFO\].*POST \/api\/agent model=(\S+) headless=\S+ task=("(?:\\.|[^"\\])*") run_id=(run_[a-z0-9]+_[a-z0-9]+)$/gim;
  for (const file of files) {
    let raw = '';
    try {
      raw = await fs.readFile(path.join(logsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of raw.matchAll(pattern)) {
      try {
        index.set(match[4], {
          task: JSON.parse(match[3]),
          model: match[2] || null,
          startedAt: Number.isFinite(Date.parse(match[1])) ? Date.parse(match[1]) : null,
        });
      } catch {
        // Ignore malformed historical log entries.
      }
    }
  }
  return index;
}

function recoverSessionFromTrace(
  events: any[],
  runId: string,
  projectId: string | null,
  logEntry: RunLogEntry | undefined,
) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const runMeta = lastEvent(events, event => event?.type === 'run_meta');
  const task = typeof runMeta?.task === 'string' && runMeta.task.trim()
    ? runMeta.task.trim()
    : logEntry?.task?.trim();
  const model = typeof runMeta?.model === 'string' && runMeta.model.trim()
    ? runMeta.model.trim()
    : logEntry?.model || null;
  if (!task || model === 'test-model' || task === 'trace test') return null;

  const terminal = lastEvent(events, event => event?.type === 'done' || event?.type === 'error');
  const done = terminal?.type === 'done' ? terminal : null;
  const error = terminal?.type === 'error' ? terminal : null;
  const plannedModels = events.flatMap(event => event?.type === 'model_plan'
    ? (event.model ? [event.model] : event.models || [])
    : []);
  const modelsUsed = uniqueStrings([...(done?.meta?.models_used || []), ...plannedModels, model]);
  const timestamps = events.map(eventTime).filter(Number.isFinite) as number[];
  const startedAt = timestamps.length > 0 ? Math.min(...timestamps) : (logEntry?.startedAt || Date.now());
  const endedAt = timestamps.length > 0 ? Math.max(...timestamps) : startedAt;
  const status = done
    ? (done.quality?.status || done.meta?.status || 'done')
    : error?.error === 'Agent 已取消' ? 'cancelled' : error ? 'error' : 'incomplete';
  const messages: any[] = [{ role: 'user', content: task, ts: startedAt, ...(model ? { model } : {}), ...(modelsUsed.length ? { modelsUsed } : {}) }];
  if (done?.answer) {
    messages.push({ role: 'assistant', content: done.answer, ts: endedAt, ...(modelsUsed[0] ? { model: modelsUsed[0] } : {}), ...(modelsUsed.length ? { modelsUsed } : {}) });
  } else if (error?.error) {
    messages.push({ role: 'assistant', content: `Agent 运行失败：${error.error}`, ts: endedAt, ...(modelsUsed[0] ? { model: modelsUsed[0] } : {}), ...(modelsUsed.length ? { modelsUsed } : {}) });
  }

  const sessionId = typeof runMeta?.sessionId === 'string' && runMeta.sessionId.trim()
    ? runMeta.sessionId.trim()
    : `session_trace_${runId.slice(4)}`;
  const agentMeta = {
    task,
    startedAt,
    endedAt,
    elapsedMs: Number.isFinite(done?.meta?.elapsed_ms) ? done.meta.elapsed_ms : Math.max(0, endedAt - startedAt),
    totalTokens: 0,
    stepCount: Number.isFinite(done?.meta?.step_count) ? done.meta.step_count : 0,
    models: modelsUsed,
    strategy: typeof runMeta?.strategy === 'string' ? runMeta.strategy : 'race',
    status,
    runId,
  };
  return normalizeSession({
    id: sessionId,
    messages,
    model: modelsUsed[0] || model,
    modelsUsed,
    agentRunId: runId,
    agentMeta,
    agentRuns: [{ runId, trace: [], meta: agentMeta }],
    createdAt: startedAt,
    updatedAt: endedAt,
  }, projectId);
}

export function createSessionStore({ memoryDir, projectStore }: { memoryDir: string; projectStore: ProjectStore }) {
  const queues = new Map<string, ReturnType<typeof createPersistenceQueue>>();
  const queueFor = (dataDir: string) => {
    let queue = queues.get(dataDir);
    if (!queue) {
      queue = createPersistenceQueue();
      queues.set(dataDir, queue);
    }
    return queue;
  };
  const scopes = () => [
    { projectId: null as string | null, dataDir: memoryDir },
    ...projectStore.list().projects.map((project: any) => ({
      projectId: project.projectId as string,
      dataDir: projectDataDir(memoryDir, project.projectId),
    })),
  ];
  const resolveScope = (projectId: string | null) => {
    if (!projectId) return { projectId: null, dataDir: memoryDir };
    const project = projectStore.get(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    return { projectId, dataDir: projectDataDir(memoryDir, projectId) };
  };

  async function loadScope(projectId: string | null, dataDir: string, logIndex: Map<string, RunLogEntry>) {
    return queueFor(dataDir).enqueue(async () => {
      const state = await readScopeState(dataDir, projectId);
      const represented = new Set(state.sessions.flatMap(sessionRunIds));
      const ignored = new Set([...state.dismissedTraceRunIds, ...state.skippedTraceRunIds]);
      let changed = false;
      for (const runId of await listTraceRuns(dataDir)) {
        if (represented.has(runId) || ignored.has(runId)) continue;
        const recovered = recoverSessionFromTrace(await readTraceEvents(dataDir, runId), runId, projectId, logIndex.get(runId));
        if (recovered) {
          state.sessions.push(recovered);
          represented.add(runId);
        } else {
          state.skippedTraceRunIds.push(runId);
        }
        changed = true;
      }
      state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!state.activeSessionId || !state.sessions.some(session => session.id === state.activeSessionId && isActiveSession(session))) {
        state.activeSessionId = state.sessions.find(isActiveSession)?.id || null;
        changed = true;
      }
      if (changed) await writeScopeState(dataDir, state);
      return state;
    });
  }

  async function loadAll() {
    const logIndex = await loadRunLogIndex(memoryDir);
    const loaded = await Promise.all(scopes().map(scope => loadScope(scope.projectId, scope.dataDir, logIndex)));
    const sessions = loaded.flatMap(state => state.sessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const activeProjectId = projectStore.list().activeProjectId ?? null;
    const activeScopeIndex = scopes().findIndex(scope => scope.projectId === activeProjectId);
    const activeSessionId = loaded[activeScopeIndex]?.activeSessionId || sessions[0]?.id || null;
    return { version: SESSION_VERSION, sessions, activeSessionId };
  }

  // 单条 upsert：客户端只同步“发生变化的那一条”会话，绝不推整份列表，
  // 因此不存在“列表里缺失即删除”的推断——过期客户端最多回退它见过的某条,
  // 无法删除它从未见过的会话。删除必须走显式 deleteSession。
  async function upsertSession(rawSession: unknown) {
    if (!rawSession || typeof rawSession !== 'object') throw new Error('session 必须是对象');
    const requestedProjectId = typeof (rawSession as any).projectId === 'string' && (rawSession as any).projectId
      ? (rawSession as any).projectId
      : null;
    const scope = resolveScope(requestedProjectId);
    const normalized = normalizeSession(rawSession, scope.projectId);
    if (!normalized) throw new Error('session 无效');
    await queueFor(scope.dataDir).enqueue(async () => {
      const state = await readScopeState(scope.dataDir, scope.projectId);
      // 不复活已被显式删除(拉黑)的会话——挡住过期标签页把删掉的会话又推回来。
      const dismissed = new Set(state.dismissedTraceRunIds);
      if (sessionRunIds(normalized).some(runId => dismissed.has(runId))) return;
      const index = state.sessions.findIndex(session => session.id === normalized.id);
      if (index >= 0) {
        // updatedAt 守卫：过期客户端不得回退后端已写入的更新的会话状态。
        if ((normalized.updatedAt || 0) < (state.sessions[index].updatedAt || 0)) return;
        state.sessions[index] = normalized;
      } else {
        state.sessions.unshift(normalized);
      }
      await writeScopeState(scope.dataDir, state);
    });
    return loadAll();
  }

  // 显式删除：从存量移除会话,并把它的 runId 加进 dismissedTraceRunIds
  // (阻止 trace 恢复复活它)。这是 dismissedTraceRunIds 唯一的写入点。
  async function deleteSession(projectId: string | null, sessionId: string) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId 不能为空');
    const scope = resolveScope(projectId);
    await queueFor(scope.dataDir).enqueue(async () => {
      const state = await readScopeState(scope.dataDir, scope.projectId);
      const target = state.sessions.find(session => session.id === sessionId);
      const dismissed = new Set(state.dismissedTraceRunIds);
      if (target) for (const runId of sessionRunIds(target)) dismissed.add(runId);
      state.sessions = state.sessions.filter(session => session.id !== sessionId);
      state.dismissedTraceRunIds = [...dismissed];
      if (state.activeSessionId === sessionId) {
        state.activeSessionId = state.sessions.find(isActiveSession)?.id || null;
      }
      await writeScopeState(scope.dataDir, state);
    });
    return loadAll();
  }

  async function mutateScope(projectId: string | null, updater: (state: ScopeState) => void | Promise<void>) {
    const scope = resolveScope(projectId);
    return queueFor(scope.dataDir).enqueue(async () => {
      const state = await readScopeState(scope.dataDir, scope.projectId);
      await updater(state);
      state.sessions = state.sessions
        .map(session => normalizeSession(session, scope.projectId))
        .filter(Boolean) as StoredSession[];
      state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!state.activeSessionId || !state.sessions.some(session => session.id === state.activeSessionId && isActiveSession(session))) {
        state.activeSessionId = state.sessions.find(isActiveSession)?.id || null;
      }
      await writeScopeState(scope.dataDir, state);
    });
  }

  async function recordRunStart({
    projectId, sessionId, runId, task, model, models, startedAt, retry,
  }: {
    projectId: string | null;
    sessionId: string | null;
    runId: string;
    task: string;
    model: string;
    models: string[];
    startedAt: number;
    retry?: boolean;
  }) {
    const id = sessionId || `session_trace_${runId.slice(4)}`;
    await mutateScope(projectId, state => {
      let session = state.sessions.find(item => item.id === id);
      if (!session) {
        session = normalizeSession({ id, projectId, createdAt: startedAt, updatedAt: startedAt }, projectId)!;
        state.sessions.unshift(session);
      }
      const runModels = uniqueStrings(models.length ? models : [model]);
      if (!retry) {
        session.messages.push({ role: 'user', content: task, ts: startedAt, model, modelsUsed: runModels });
      }
      session.messages.push({ role: 'assistant', content: 'Agent 正在运行…', pending: 'run', ts: startedAt, model, modelsUsed: runModels });
      session.model = model;
      session.modelsUsed = runModels;
      session.agentRunId = runId;
      session.agentMeta = null;
      session.updatedAt = startedAt;
      state.activeSessionId = id;
    });
  }

  async function recordRunTerminal({
    projectId, sessionId, runId, task, answer, error, models, status, startedAt, endedAt, meta,
  }: {
    projectId: string | null;
    sessionId: string | null;
    runId: string;
    task: string;
    answer: string | null;
    error: string | null;
    models: string[];
    status: string;
    startedAt: number;
    endedAt: number;
    meta?: Record<string, any>;
  }) {
    const id = sessionId || `session_trace_${runId.slice(4)}`;
    await mutateScope(projectId, state => {
      let session = state.sessions.find(item => item.id === id);
      if (!session) {
        session = normalizeSession({
          id,
          messages: [{ role: 'user', content: task, ts: startedAt }],
          createdAt: startedAt,
        }, projectId)!;
        state.sessions.unshift(session);
      }
      const runModels = uniqueStrings(models);
      const content = answer || (error ? `Agent 运行失败：${error}` : 'Agent 运行已结束');
      let pendingIndex = -1;
      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        if (session.messages[index]?.role === 'assistant' && session.messages[index]?.pending === 'run') {
          pendingIndex = index;
          break;
        }
      }
      const assistantMessage = { role: 'assistant', content, ts: endedAt, ...(runModels[0] ? { model: runModels[0] } : {}), ...(runModels.length ? { modelsUsed: runModels } : {}) };
      if (pendingIndex >= 0) session.messages[pendingIndex] = assistantMessage;
      else session.messages.push(assistantMessage);
      const agentMeta = {
        task,
        startedAt,
        endedAt,
        elapsedMs: Number.isFinite(meta?.elapsed_ms) ? meta!.elapsed_ms : Math.max(0, endedAt - startedAt),
        totalTokens: 0,
        stepCount: Number.isFinite(meta?.step_count) ? meta!.step_count : 0,
        models: runModels,
        strategy: 'race',
        status,
        runId,
      };
      session.model = runModels[0] || session.model;
      session.modelsUsed = runModels;
      session.agentRunId = runId;
      session.agentMeta = agentMeta;
      session.agentRuns = [{ runId, trace: [], meta: agentMeta }, ...normalizeAgentRuns(session.agentRuns).filter(run => run.runId !== runId)].slice(0, 30);
      session.updatedAt = endedAt;
      state.activeSessionId = id;
    });
  }

  return { loadAll, upsertSession, deleteSession, recordRunStart, recordRunTerminal };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
