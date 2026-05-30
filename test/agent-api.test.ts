import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// We test the agent router in isolation by mocking the heavy deps
vi.mock('../agent/core/ai-client.js', () => ({
  createClients: () => ({ openai_client: null, anthropic_client: null }),
  loadModelConfig: () => [{ id: 'test-model', provider: 'test' }],
  loadAgentMultiModels: () => [],
  isClaudeModel: () => false,
}));

vi.mock('../agent/desktop/agent.js', () => ({
  createDesktopAgentRunner: () => (() => Promise.resolve({ answer: 'test', steps: [] })),
}));

let tmpDir;
let app;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-api-test-'));
  const { createAgentRouter } = await import('../routes/agent.js');
  const { createAgentRunStore } = await import('../helpers/run-store.js');
  const { createApprovalStore } = await import('../agent/core/approval-store.js');

  const agentRunStore = createAgentRunStore();
  const approvalStore = createApprovalStore();

  const router = createAgentRouter({
    runDesktopAgent: async () => ({ answer: 'done', steps: [] }),
    agentRunStore,
    approvalStore,
    memoryDir: tmpDir,
    checkpointDir: tmpDir,
    domainRules: null,
    modelConfig: [{ id: 'test-model', provider: 'test' }],
    openai_client: null,
    anthropic_client: null,
  });

  app = express();
  app.use(express.json());
  app.use(router);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('POST /api/agent/compact', () => {
  it('returns 200 and compacts memory', async () => {
    // Write some memory entries
    const { loadMemory, saveMemory } = await import('../agent/core/memory.js');
    const mem = await loadMemory(tmpDir);
    for (let i = 0; i < 25; i++) {
      mem.conversation.push({ task: `task ${i}`, summary: `result ${i}`, timestamp: new Date().toISOString(), model: 'test', filesTouched: [], toolsUsed: [] });
    }
    await saveMemory(tmpDir, mem);

    const res = await request(app).post('/api/agent/compact');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/保留 \d+ 条/);
  });

  it('returns ok:false when no memory', async () => {
    // loadMemory returns empty memory which is truthy, so this tests the compact of empty data
    const res = await request(app).post('/api/agent/compact');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('0');
  });
});

describe('GET /api/agent/memory', () => {
  it('returns counts for empty memory', async () => {
    const res = await request(app).get('/api/agent/memory');
    expect(res.status).toBe(200);
    expect(res.body.conversationCount).toBe(0);
    expect(res.body.summaryLength).toBe(0);
    expect(res.body.conversation).toEqual([]);
    expect(res.body.conversationSummary).toBe('');
    expect(res.body.projectKnowledge).toBeDefined();
  });

  it('returns counts after saving memory', async () => {
    const { loadMemory, saveMemory } = await import('../agent/core/memory.js');
    const mem = await loadMemory(tmpDir);
    mem.conversation.push({ task: 'test', summary: 'done', timestamp: new Date().toISOString(), model: 'test', filesTouched: [], toolsUsed: [] });
    await saveMemory(tmpDir, mem);

    const res = await request(app).get('/api/agent/memory');
    expect(res.status).toBe(200);
    expect(res.body.conversationCount).toBe(1);
    expect(res.body.summaryLength).toBe(0);
    expect(res.body.conversation).toHaveLength(1);
    expect(res.body.conversation[0].task).toBe('test');
    expect(res.body.projectKnowledge).toBeDefined();
  });
});

describe('GET /api/agent/traces/:runId', () => {
  it('returns persisted trace events for an agent run', async () => {
    const res = await request(app)
      .post('/api/agent')
      .send({ task: 'trace test', model: 'test-model', memory: false })
      .buffer(true)
      .parse((response, callback) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => callback(null, body));
      });

    expect(res.status).toBe(200);
    const responseText = typeof res.text === 'string' ? res.text : String(res.body || '');
    const runIdMatch = responseText.match(/"runId":"([^"]+)"/);
    expect(runIdMatch).toBeTruthy();
    const runId = runIdMatch![1];

    const traceRes = await request(app).get(`/api/agent/traces/${runId}`);
    expect(traceRes.status).toBe(200);
    expect(traceRes.body.runId).toBe(runId);
    expect(traceRes.body.events.some((event: any) => event.type === 'status')).toBe(true);
    expect(traceRes.body.events.some((event: any) => event.type === 'done')).toBe(true);
  });
});

describe('POST /api/agent { background: true }', () => {
  it('returns runId immediately as JSON (not SSE)', async () => {
    const res = await request(app)
      .post('/api/agent')
      .send({ task: 'bg test', model: 'test-model', memory: false, background: true });

    expect(res.status).toBe(202);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.runId).toMatch(/^run_/);
    expect(res.body.status).toBe('running');
    expect(typeof res.body.startedAt).toBe('number');
  });
});

describe('GET /api/agent/:runId/status', () => {
  it('reports done status and final answer after a background run completes', async () => {
    const startRes = await request(app)
      .post('/api/agent')
      .send({ task: 'status test', model: 'test-model', memory: false, background: true });
    const runId = startRes.body.runId;

    // 默认 mock agent 立即 resolve；轮询直到 done 落盘
    let statusRes;
    for (let i = 0; i < 20; i++) {
      statusRes = await request(app).get(`/api/agent/${runId}/status`);
      if (statusRes.body.done) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(statusRes!.status).toBe(200);
    expect(statusRes!.body.runId).toBe(runId);
    expect(statusRes!.body.status).toBe('done');
    expect(statusRes!.body.done).toBe(true);
    expect(statusRes!.body.answer).toBe('done');
  });

  it('returns 404 for an unknown runId', async () => {
    const res = await request(app).get('/api/agent/run_unknown_abc123/status');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed runId', async () => {
    const res = await request(app).get('/api/agent/not-a-valid-id/status');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/agent/:runId/cancel', () => {
  it('cancels a run and returns ok', async () => {
    const startRes = await request(app)
      .post('/api/agent')
      .send({ task: 'cancel test', model: 'test-model', memory: false, background: true });
    const runId = startRes.body.runId;

    const cancelRes = await request(app).post(`/api/agent/${runId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.ok).toBe(true);
  });

  it('returns 400 for a malformed runId', async () => {
    const res = await request(app).post('/api/agent/not-a-valid-id/cancel');
    expect(res.status).toBe(400);
  });
});

describe('concurrent runs', () => {
  // 构造一个 runner 可被外部控制完成时机的 app,让多个 background 任务同时处于 running 状态
  async function buildConcurrentApp(maxConcurrent?: number) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-concurrent-'));
    const { createAgentRouter } = await import('../routes/agent.js');
    const { createAgentRunStore } = await import('../helpers/run-store.js');
    const { createApprovalStore } = await import('../agent/core/approval-store.js');

    const agentRunStore = createAgentRunStore();
    const approvalStore = createApprovalStore();
    const gates: Array<() => void> = [];

    // 每次调用挂起,直到 release() 被触发,模拟"任务在跑"
    const runDesktopAgent = () =>
      new Promise(resolve => {
        gates.push(() => resolve({ answer: 'done', steps: [] }));
      });

    if (maxConcurrent != null) process.env.AGENT_MAX_CONCURRENT = String(maxConcurrent);
    else delete process.env.AGENT_MAX_CONCURRENT;

    const router = createAgentRouter({
      runDesktopAgent,
      agentRunStore,
      approvalStore,
      memoryDir: dir,
      checkpointDir: dir,
      domainRules: null,
      modelConfig: [{ id: 'test-model', provider: 'test' }],
      openai_client: null,
      anthropic_client: null,
    });
    const localApp = express();
    localApp.use(express.json());
    localApp.use(router);

    const releaseAll = () => { gates.forEach(g => g()); gates.length = 0; };
    const cleanup = async () => {
      releaseAll();
      delete process.env.AGENT_MAX_CONCURRENT;
      await fs.rm(dir, { recursive: true, force: true });
    };
    return { app: localApp, releaseAll, cleanup };
  }

  it('GET /api/agent/runs lists multiple active runs', async () => {
    const { app: localApp, cleanup } = await buildConcurrentApp(3);
    try {
      const r1 = await request(localApp).post('/api/agent').send({ task: 't1', model: 'test-model', memory: false, background: true });
      const r2 = await request(localApp).post('/api/agent').send({ task: 't2', model: 'test-model', memory: false, background: true });
      expect(r1.status).toBe(202);
      expect(r2.status).toBe(202);

      const runsRes = await request(localApp).get('/api/agent/runs');
      expect(runsRes.status).toBe(200);
      expect(runsRes.body.runs).toHaveLength(2);
      const ids = runsRes.body.runs.map((r: any) => r.runId);
      expect(ids).toContain(r1.body.runId);
      expect(ids).toContain(r2.body.runId);
    } finally {
      await cleanup();
    }
  });

  it('returns 429 when concurrency limit is reached', async () => {
    const { app: localApp, cleanup } = await buildConcurrentApp(2);
    try {
      const r1 = await request(localApp).post('/api/agent').send({ task: 't1', model: 'test-model', memory: false, background: true });
      const r2 = await request(localApp).post('/api/agent').send({ task: 't2', model: 'test-model', memory: false, background: true });
      expect(r1.status).toBe(202);
      expect(r2.status).toBe(202);

      // 第三个超过上限 2
      const r3 = await request(localApp).post('/api/agent').send({ task: 't3', model: 'test-model', memory: false, background: true });
      expect(r3.status).toBe(429);
      expect(r3.body.activeRuns).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('cancelling one run does not affect another', async () => {
    const { app: localApp, cleanup } = await buildConcurrentApp(3);
    try {
      const r1 = await request(localApp).post('/api/agent').send({ task: 't1', model: 'test-model', memory: false, background: true });
      const r2 = await request(localApp).post('/api/agent').send({ task: 't2', model: 'test-model', memory: false, background: true });

      const cancelRes = await request(localApp).post(`/api/agent/${r1.body.runId}/cancel`);
      expect(cancelRes.status).toBe(200);

      // run B 仍在 active 列表里
      const runsRes = await request(localApp).get('/api/agent/runs');
      const ids = runsRes.body.runs.map((r: any) => r.runId);
      expect(ids).toContain(r2.body.runId);
      expect(ids).not.toContain(r1.body.runId);
    } finally {
      await cleanup();
    }
  });
});
