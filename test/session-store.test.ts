import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectStore, projectDataDir, GLOBAL_SCOPE_ID } from '../agent/core/project-store.js';
import { createSessionStore } from '../agent/core/session-store.js';
import { appendTraceEvent } from '../helpers/trace-store.js';
import { withPrivateRun } from '../helpers/private-run.js';

describe('backend session store', () => {
  let tmpDir: string;
  // 无项目 scope 的落盘目录:与项目目录同级的 projects/default 全局桶。
  let globalDataDir: string;
  let projectStore: ReturnType<typeof createProjectStore>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-sessions-'));
    globalDataDir = projectDataDir(tmpDir, GLOBAL_SCOPE_ID);
    projectStore = createProjectStore(tmpDir);
    await projectStore.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('recovers a conversation from run_meta and terminal trace events', async () => {
    const runId = 'run_session_recover';
    await appendTraceEvent(globalDataDir, runId, {
      type: 'run_meta',
      runId,
      sessionId: 'session_backend',
      task: '恢复这个问题',
      model: 'model-a',
      startedAt: 1000,
      timestamp: 1000,
    });
    await appendTraceEvent(globalDataDir, runId, {
      type: 'done',
      runId,
      answer: '恢复后的答案',
      timestamp: 2000,
      meta: { models_used: ['model-a'], step_count: 2, status: 'done' },
    });

    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    const state = await store.loadAll();

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      id: 'session_backend',
      projectId: null,
      agentRunId: runId,
      model: 'model-a',
    });
    expect(state.sessions[0].messages).toEqual([
      expect.objectContaining({ role: 'user', content: '恢复这个问题' }),
      expect.objectContaining({ role: 'assistant', content: '恢复后的答案' }),
    ]);
  });

  it('uses historical app logs to recover tasks missing from legacy traces', async () => {
    const runId = 'run_legacy_trace';
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'logs', 'app-2026-07-12.log'),
      `[2026-07-12T08:00:00.000Z INFO] POST /api/agent model=model-b headless=false task="旧版问题" run_id=${runId}\n`,
      'utf8',
    );
    await appendTraceEvent(globalDataDir, runId, { type: 'status', status: 'starting', timestamp: 1000 });
    await appendTraceEvent(globalDataDir, runId, { type: 'done', answer: '旧版答案', timestamp: 2000, meta: {} });

    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    const state = await store.loadAll();

    expect(state.sessions[0].messages[0].content).toBe('旧版问题');
    expect(state.sessions[0].messages[1].content).toBe('旧版答案');
  });

  it('keeps sessions a stale client simply omits (no delete-by-absence)', async () => {
    // 回归本次 bug：过期客户端只 upsert 它自己那条,完全没提到已存在的会话,
    // 已存在的会话必须原样保留、绝不能被“缺失”推断成删除。
    const runId = 'run_kept_trace';
    await appendTraceEvent(globalDataDir, runId, {
      type: 'run_meta', task: '保留我', model: 'model-a', startedAt: 1000, timestamp: 1000,
    });
    await appendTraceEvent(globalDataDir, runId, { type: 'done', answer: '答案', timestamp: 2000, meta: {} });
    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    const recovered = await store.loadAll();
    expect(recovered.sessions).toHaveLength(1);

    await store.upsertSession({
      id: 'session_blank', projectId: null, messages: [], createdAt: 3000, updatedAt: 3000,
    });
    const reloaded = await store.loadAll();

    expect(reloaded.sessions).toHaveLength(2);
    expect(reloaded.sessions.some(session => session.id === 'session_blank')).toBe(true);
    expect(reloaded.sessions.some(session => session.agentRunId === runId)).toBe(true);
  });

  it('does not resurrect trace sessions after an explicit delete', async () => {
    const runId = 'run_removed_trace';
    await appendTraceEvent(globalDataDir, runId, {
      type: 'run_meta', task: '稍后删除', model: 'model-a', startedAt: 1000, timestamp: 1000,
    });
    await appendTraceEvent(globalDataDir, runId, { type: 'done', answer: '答案', timestamp: 2000, meta: {} });
    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    const recovered = await store.loadAll();
    expect(recovered.sessions).toHaveLength(1);
    const targetId = recovered.sessions[0].id;

    await store.deleteSession(null, targetId);
    const reloaded = await store.loadAll();
    expect(reloaded.sessions.some(session => session.id === targetId)).toBe(false);

    // 用全新 store 再跑一次 loadAll：trace 仍在磁盘,但已被拉黑,不能复活。
    const fresh = createSessionStore({ memoryDir: tmpDir, projectStore });
    const again = await fresh.loadAll();
    expect(again.sessions.some(session => session.id === targetId)).toBe(false);
  });

  it('upsertSession will not let an older write revert a newer session (updatedAt guard)', async () => {
    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    await store.upsertSession({
      id: 's1', projectId: null, messages: [{ role: 'user', content: 'new' }], createdAt: 1000, updatedAt: 5000,
    });
    // 过期客户端用更旧的 updatedAt 覆盖 → 应被守卫挡下。
    await store.upsertSession({
      id: 's1', projectId: null, messages: [{ role: 'user', content: 'stale' }], createdAt: 1000, updatedAt: 2000,
    });
    const reloaded = await store.loadAll();
    const s1 = reloaded.sessions.find(session => session.id === 's1');
    expect(s1?.messages?.[0]?.content).toBe('new');
  });

  it('does not persist private run sessions or read-only recovery changes', async () => {
    const runId = 'run_private_session';
    const store = createSessionStore({ memoryDir: tmpDir, projectStore });

    await store.recordRunStart({
      projectId: null,
      sessionId: 'session_private',
      runId,
      task: '不应写入的任务',
      model: 'model-private',
      models: ['model-private'],
      startedAt: 1000,
      privateMode: true,
    });
    await store.recordRunTerminal({
      projectId: null,
      sessionId: 'session_private',
      runId,
      task: '不应写入的任务',
      answer: '不应写入的答案',
      error: null,
      models: ['model-private'],
      status: 'done',
      startedAt: 1000,
      endedAt: 2000,
      privateMode: true,
    });

    await expect(fs.access(path.join(globalDataDir, 'chat-sessions.json'))).rejects.toThrow();

    // 即使调用方漏传 privateMode，异步隐私上下文也会挡住写入。
    await withPrivateRun(true, () => store.upsertSession({
      id: 'session_private_context',
      messages: [{ role: 'user', content: '上下文隐私' }],
      updatedAt: 3000,
    }));
    await expect(fs.access(path.join(globalDataDir, 'chat-sessions.json'))).rejects.toThrow();

    await appendTraceEvent(globalDataDir, 'run_readonly_recovery', {
      type: 'run_meta',
      task: '只读恢复',
      model: 'model-read-only',
      startedAt: 4000,
      timestamp: 4000,
    });
    await appendTraceEvent(globalDataDir, 'run_readonly_recovery', {
      type: 'done',
      answer: '只读答案',
      timestamp: 5000,
      meta: {},
    });
    const readOnly = await store.loadAll({ persist: false });
    expect(readOnly.sessions.some(session => session.messages.some(message => message.content === '只读恢复'))).toBe(true);
    await expect(fs.access(path.join(globalDataDir, 'chat-sessions.json'))).rejects.toThrow();
  });

  it('recovers project traces with the correct project ownership', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-project-root-'));
    try {
      const project = await projectStore.create({ name: 'demo', rootPath: projectRoot });
      const dataDir = projectDataDir(tmpDir, project.projectId);
      const runId = 'run_project_trace';
      await appendTraceEvent(dataDir, runId, {
        type: 'run_meta', task: '项目问题', model: 'model-c', startedAt: 1000, timestamp: 1000,
      });
      await appendTraceEvent(dataDir, runId, { type: 'done', answer: '项目答案', timestamp: 2000, meta: {} });

      const store = createSessionStore({ memoryDir: tmpDir, projectStore });
      const state = await store.loadAll();

      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].projectId).toBe(project.projectId);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
