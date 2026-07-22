import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectStore, projectDataDir } from '../agent/core/project-store.js';
import { createSessionStore } from '../agent/core/session-store.js';
import { appendTraceEvent } from '../helpers/trace-store.js';

describe('backend session store', () => {
  let tmpDir: string;
  let projectStore: ReturnType<typeof createProjectStore>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-sessions-'));
    projectStore = createProjectStore(tmpDir);
    await projectStore.init();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('recovers a conversation from run_meta and terminal trace events', async () => {
    const runId = 'run_session_recover';
    await appendTraceEvent(tmpDir, runId, {
      type: 'run_meta',
      runId,
      sessionId: 'session_backend',
      task: '恢复这个问题',
      model: 'model-a',
      startedAt: 1000,
      timestamp: 1000,
    });
    await appendTraceEvent(tmpDir, runId, {
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
    await appendTraceEvent(tmpDir, runId, { type: 'status', status: 'starting', timestamp: 1000 });
    await appendTraceEvent(tmpDir, runId, { type: 'done', answer: '旧版答案', timestamp: 2000, meta: {} });

    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    const state = await store.loadAll();

    expect(state.sessions[0].messages[0].content).toBe('旧版问题');
    expect(state.sessions[0].messages[1].content).toBe('旧版答案');
  });

  it('keeps sessions a stale client simply omits (no delete-by-absence)', async () => {
    // 回归本次 bug：过期客户端只 upsert 它自己那条,完全没提到已存在的会话,
    // 已存在的会话必须原样保留、绝不能被“缺失”推断成删除。
    const runId = 'run_kept_trace';
    await appendTraceEvent(tmpDir, runId, {
      type: 'run_meta', task: '保留我', model: 'model-a', startedAt: 1000, timestamp: 1000,
    });
    await appendTraceEvent(tmpDir, runId, { type: 'done', answer: '答案', timestamp: 2000, meta: {} });
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
    await appendTraceEvent(tmpDir, runId, {
      type: 'run_meta', task: '稍后删除', model: 'model-a', startedAt: 1000, timestamp: 1000,
    });
    await appendTraceEvent(tmpDir, runId, { type: 'done', answer: '答案', timestamp: 2000, meta: {} });
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
