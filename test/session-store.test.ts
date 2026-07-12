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

  it('does not resurrect trace sessions after the user removes them', async () => {
    const runId = 'run_removed_trace';
    await appendTraceEvent(tmpDir, runId, {
      type: 'run_meta', task: '稍后删除', model: 'model-a', startedAt: 1000, timestamp: 1000,
    });
    await appendTraceEvent(tmpDir, runId, { type: 'done', answer: '答案', timestamp: 2000, meta: {} });
    const store = createSessionStore({ memoryDir: tmpDir, projectStore });
    const recovered = await store.loadAll();
    expect(recovered.sessions).toHaveLength(1);

    await store.replaceAll([{
      id: 'session_blank',
      projectId: null,
      messages: [],
      createdAt: 3000,
      updatedAt: 3000,
    }], 'session_blank');
    const reloaded = await store.loadAll();

    expect(reloaded.sessions).toHaveLength(1);
    expect(reloaded.sessions[0].id).toBe('session_blank');
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
