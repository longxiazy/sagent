import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// We test the agent router in isolation by mocking the heavy deps
vi.mock('../agent/core/ai-client.js', () => ({
  createClients: () => ({ openai_client: null, gemini_client: null }),
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
let agentRunStore;
let approvalStore;
let projectStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-api-test-'));
  const { createAgentRouter } = await import('../routes/agent.js');
  const { createAgentRunStore } = await import('../helpers/run-store.js');
  const { createApprovalStore } = await import('../agent/core/approval-store.js');
  const { runtimeConfig } = await import('../agent/core/runtime-config.js');
  const { createProjectStore } = await import('../agent/core/project-store.js');

  agentRunStore = createAgentRunStore();
  approvalStore = createApprovalStore();
  // 空注册表 → resolveRunPaths 回退到 tmpDir/process.cwd()，与无项目态一致。
  projectStore = createProjectStore(tmpDir);
  await projectStore.init();

  const router = createAgentRouter({
    runDesktopAgent: async () => ({ answer: 'done', steps: [] }),
    agentRunStore,
    approvalStore,
    memoryDir: tmpDir,
    checkpointDir: tmpDir,
    domainRules: null,
    modelConfig: [{ id: 'test-model', label: 'test-model', provider: 'test' }],
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

    const res = await request(app)
      .post('/api/agent/compact')
      .send({ model: 'test-model' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/保留 \d+ 条/);
  });

  it('returns ok:false when no memory', async () => {
    // loadMemory returns empty memory which is truthy, so this tests the compact of empty data
    const res = await request(app)
      .post('/api/agent/compact')
      .send({ model: 'test-model' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('0');
  });

  it('requires an explicit compact model', async () => {
    const res = await request(app).post('/api/agent/compact');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('model');
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

describe('GET /api/agent/active', () => {
  it('returns pending approval details for a reconnected run', async () => {
    const run = agentRunStore.createRun({
      model: 'test-model',
      task: 'needs approval',
    });
    approvalStore.request({
      type: 'approval_required',
      runId: run.runId,
      step: 3,
      action: { tool: 'terminal', type: 'run', command: 'npm test' },
      message: '命令需要确认',
    }, 'approval_reconnect_1');

    const res = await request(app).get('/api/agent/active');
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.runId).toBe(run.runId);
    expect(res.body.pendingApproval).toMatchObject({
      type: 'approval_required',
      runId: run.runId,
      approvalId: 'approval_reconnect_1',
      step: 3,
      message: '命令需要确认',
      action: { tool: 'terminal', type: 'run', command: 'npm test' },
    });
    expect(res.body.pendingQuestion).toBeNull();

    approvalStore.rejectAll();
  });
});

describe('approval ownership', () => {
  it('rejects approval decisions submitted with another run id', async () => {
    approvalStore.request({
      type: 'approval_required',
      runId: 'run_owner',
      action: { tool: 'terminal', type: 'run_confirmed', command: 'npm test', cwd: '', timeoutMs: 12000 },
    }, 'approval_owner_1');

    const res = await request(app)
      .post('/api/agent/approvals')
      .send({ runId: 'run_other', approvalId: 'approval_owner_1', decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPROVAL_RUN_MISMATCH');
    expect(approvalStore.getPendingForRun('run_owner')?.approvalId).toBe('approval_owner_1');
    approvalStore.rejectAll();
  });

  it('rejects question responses submitted with another run id', async () => {
    approvalStore.request({
      type: 'question_required',
      runId: 'run_question_owner',
      action: { tool: 'ask_user', type: 'question', question: 'Continue?' },
    }, 'question_owner_1');

    const res = await request(app)
      .post('/api/agent/question')
      .send({ runId: 'run_other', approvalId: 'question_owner_1', response: 'yes' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPROVAL_RUN_MISMATCH');
    expect(approvalStore.getPendingForRun('run_question_owner')?.approvalId).toBe('question_owner_1');
    approvalStore.rejectAll();
  });
});

describe('POST /api/agent', () => {
  it('requires an explicit model selection', async () => {
    const res = await request(app)
      .post('/api/agent')
      .send({ task: 'needs model', memory: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('模型');
  });

  it('returns a clear validation error when the selected project directory was moved', async () => {
    const projectRoot = path.join(tmpDir, 'movable-project');
    await fs.mkdir(projectRoot);
    const project = await projectStore.create({ name: 'movable', rootPath: projectRoot });
    await fs.rm(projectRoot, { recursive: true, force: true });

    const res = await request(app)
      .post('/api/agent')
      .send({ task: 'inspect project', model: 'test-model', memory: false, projectId: project.projectId });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_ROOT_UNAVAILABLE');
    expect(res.body.error).toContain('项目根目录不存在或已移动');
  });

  it('returns JSON errors for startup failures before the SSE stream opens', async () => {
    const { createAgentRouter } = await import('../routes/agent.js');
    const failingApp = express();
    failingApp.use(express.json());
    failingApp.use(createAgentRouter({
      runDesktopAgent: async () => ({ answer: 'done', steps: [] }),
      agentRunStore,
      approvalStore,
      memoryDir: tmpDir,
      checkpointDir: tmpDir,
      domainRules: null,
      modelConfig: [{ id: 'test-model', provider: 'test' }],
      registry: mockRegistry,
      runtimeConfig: {},
      projectStore: {
        get() {
          throw new Error('project lookup failed');
        },
      },
    } as any));

    const res = await request(failingApp)
      .post('/api/agent')
      .send({ task: 'startup failure', model: 'test-model', memory: false, projectId: 'broken-project' });

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toBe('project lookup failed');
  });
});

describe('POST /api/agent/context', () => {
  it('returns context usage based on the server-built agent prompt', async () => {
    const res = await request(app)
      .post('/api/agent/context')
      .send({
        task: 'inspect the repo',
        model: 'test-model',
        models: ['test-model'],
        memory: false,
        messages: [{ role: 'user', content: 'previous message' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('server_actual_prompt');
    expect(res.body.usedTokens).toBeGreaterThan(0);
    expect(res.body.max.modelId).toBe('test-model');
    expect(res.body.usedLabel).toBeTruthy();
    expect(res.body.promptPreview.modelId).toBe('test-model');
    expect(res.body.promptPreview.text).toContain('inspect the repo');
    expect(res.body.promptPreview.text).toContain('previous message');
    expect(res.body.max.promptPreview).toBeUndefined();
    expect(res.body.modelEstimates.every((item: any) => item.promptPreview == null)).toBe(true);
  });
});

describe('POST /api/uploads', () => {
  it('returns a controlled virtual path instead of an absolute filesystem path', async () => {
    const res = await request(app).post('/api/uploads').send({
      name: 'image.png',
      mime: 'image/png',
      data: Buffer.from('image-bytes').toString('base64'),
    });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^@uploads\/\d{4}-\d{2}-\d{2}\//);
    expect(path.isAbsolute(res.body.path)).toBe(false);
    const relativeUploadPath = res.body.path.slice('@uploads/'.length);
    await expect(fs.access(path.join(tmpDir, 'uploads', relativeUploadPath))).resolves.toBeUndefined();
  });
});

describe('GET /api/agent/stream/:runId', () => {
  it('replays only events after the requested cursor with monotonic SSE ids', async () => {
    const { createBaseEventSender } = await import('../helpers/run-agent.ts');
    const run = agentRunStore.createRun({}, 1, 'run_cursor_reconnect');
    const send = createBaseEventSender(run.runId, agentRunStore, tmpDir);
    send({ type: 'status', status: 'running', message: 'first' });
    send({ type: 'notification', level: 'info', message: 'second' });
    send({ type: 'done', answer: 'third' });
    await run.persistence?.flush();
    agentRunStore.closeRun(run.runId, 'completed');

    const res = await request(app)
      .get(`/api/agent/stream/${run.runId}?cursor=1`)
      .buffer(true)
      .parse((response, callback) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => callback(null, body));
      });

    const responseText = typeof res.text === 'string' ? res.text : String(res.body || '');
    expect(responseText).not.toContain('"message":"first"');
    expect(responseText).toContain('id: 2\n');
    expect(responseText).toContain('"message":"second"');
    expect(responseText).toContain('id: 3\n');
    expect(responseText).toContain('"answer":"third"');
  });

  it('replays pending approval details for reconnect streams', async () => {
    const run = agentRunStore.createRun({
      model: 'test-model',
      task: 'needs stream approval',
    });
    approvalStore.request({
      type: 'approval_required',
      runId: run.runId,
      step: 4,
      action: { tool: 'fs', type: 'write_file', path: 'out.txt' },
      message: '文件写入需要确认',
    }, 'approval_stream_1');
    run.status = 'done';

    const res = await request(app)
      .get(`/api/agent/stream/${run.runId}`)
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
    expect(responseText).toContain('"type":"approval_required"');
    expect(responseText).toContain('"approvalId":"approval_stream_1"');
    expect(responseText).toContain('"message":"文件写入需要确认"');

    approvalStore.rejectAll();
  });

  it('replays project traces from the run data directory', async () => {
    const { appendTraceEvent } = await import('../helpers/trace-store.ts');
    const { createBaseEventSender } = await import('../helpers/run-agent.ts');
    const projectDataDir = path.join(tmpDir, 'projects', 'project-stream');
    const run = agentRunStore.createRun({ dataDir: projectDataDir }, 1, 'run_project_stream');
    const send = createBaseEventSender(run.runId, agentRunStore, projectDataDir);
    send({ type: 'notification', level: 'info', message: 'project trace' });
    await appendTraceEvent(tmpDir, run.runId, { type: 'notification', message: 'global trace' });
    await run.persistence?.flush();
    agentRunStore.closeRun(run.runId, 'completed');

    const res = await request(app)
      .get(`/api/agent/stream/${run.runId}`)
      .buffer(true)
      .parse((response, callback) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => callback(null, body));
      });

    const responseText = typeof res.text === 'string' ? res.text : String(res.body || '');
    expect(responseText).toContain('project trace');
    expect(responseText).not.toContain('global trace');
  });
});

describe('POST /api/agent/cancel', () => {
  it('removes checkpoints from the project run directory instead of the global directory', async () => {
    const { saveCheckpoint } = await import('../agent/core/checkpoint.ts');
    const projectDataDir = path.join(tmpDir, 'projects', 'project-cancel');
    const run = agentRunStore.createRun({ dataDir: projectDataDir }, 1, 'run_project_cancel');
    await saveCheckpoint(projectDataDir, { runId: run.runId, step: 1 });
    await saveCheckpoint(tmpDir, { runId: run.runId, step: 99 });

    const res = await request(app).post('/api/agent/cancel').send({ runId: run.runId });

    expect(res.status).toBe(200);
    await expect(fs.access(path.join(projectDataDir, 'checkpoints', `${run.runId}.json`))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, 'checkpoints', `${run.runId}.json`))).resolves.toBeUndefined();
    agentRunStore.closeRun(run.runId);
  });

  it('queues cancellation cleanup after in-flight checkpoint writes', async () => {
    const { saveCheckpoint } = await import('../agent/core/checkpoint.ts');
    const projectDataDir = path.join(tmpDir, 'projects', 'project-cancel-race');
    const run = agentRunStore.createRun({ dataDir: projectDataDir }, 1, 'run_project_cancel_race');
    let releaseWrite: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    run.persistence?.enqueue(async () => {
      await gate;
      await saveCheckpoint(projectDataDir, { runId: run.runId, step: 1 });
    });

    const pendingResponse = request(app)
      .post('/api/agent/cancel')
      .send({ runId: run.runId })
      .then(response => response);
    await new Promise(resolve => setImmediate(resolve));
    releaseWrite();
    const res = await pendingResponse;

    expect(res.status).toBe(200);
    await expect(fs.access(path.join(projectDataDir, 'checkpoints', `${run.runId}.json`))).rejects.toThrow();
    agentRunStore.closeRun(run.runId);
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
