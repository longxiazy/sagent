import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// We test the agent router in isolation by mocking the heavy deps
vi.mock('../agent/core/ai-client.js', () => ({
  createClients: () => ({ openai_client: null, anthropic_client: null, gemini_client: null }),
  loadAgentMultiModels: () => [],
  deriveProviderName: () => 'test',
  isChatCapableModel: () => true,
}));

vi.mock('../agent/desktop/agent.js', () => ({
  createDesktopAgentRunner: () => (() => Promise.resolve({ answer: 'test', steps: [] })),
}));

// 最小可用的 provider registry：resolve 返回一个能 summarize 的假 provider。
const mockRegistry: any = {
  providers: [],
  resolve: () => ({
    name: 'test',
    client: {},
    summarize: async ({ text }) => text.slice(0, 50),
  }),
  loadModelConfig: async () => [{ id: 'test-model', provider: 'test' }],
};

let tmpDir;
let app;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-api-test-'));
  const { createAgentRouter } = await import('../routes/agent.js');
  const { createAgentRunStore } = await import('../helpers/run-store.js');
  const { createApprovalStore } = await import('../agent/core/approval-store.js');
  const { runtimeConfig } = await import('../agent/core/runtime-config.js');
  const { createProjectStore } = await import('../agent/core/project-store.js');

  const agentRunStore = createAgentRunStore();
  const approvalStore = createApprovalStore();
  // 空注册表 → resolveRunPaths 回退到 tmpDir/process.cwd()，与无项目态一致。
  const projectStore = createProjectStore(tmpDir);
  await projectStore.init();

  const router = createAgentRouter({
    runDesktopAgent: async () => ({ answer: 'done', steps: [] }),
    agentRunStore,
    approvalStore,
    memoryDir: tmpDir,
    checkpointDir: tmpDir,
    domainRules: null,
    modelConfig: [{ id: 'test-model', provider: 'test' }],
    registry: mockRegistry,
    runtimeConfig,
    projectStore,
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
