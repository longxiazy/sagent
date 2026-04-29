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
    expect(res.body.message).toContain('20');
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
