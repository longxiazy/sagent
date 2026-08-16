import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentConfigRouter } from '../routes/agent-config.ts';
import { configStore } from '../agent/core/config-store.ts';

function createConfigRouter(modelConfig: any[] = []) {
  return createAgentConfigRouter({
    configStore,
    projectStore: { dataDir: () => '' },
    modelConfig,
  } as any);
}

async function invoke(router: any, method: string, pathName: string, body: any = {}) {
  const layer = router.stack.find((item: any) => item.route?.path === pathName && item.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`route not found: ${method} ${pathName}`);
  const response: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  await layer.route.stack[0].handle({ body, headers: {}, query: {} }, response);
  return response;
}

describe('agent execution configuration API', () => {
  it('returns and updates Worker startup settings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-agent-config-api-'));
    await configStore.init(dir);
    const router = createConfigRouter();

    const before = await invoke(router, 'GET', '/api/config');
    expect(before.statusCode).toBe(200);
    expect(before.body.execution).toMatchObject({ sandboxedWorkers: true, workerSandbox: true });
    expect(before.body.executionSources).toMatchObject({ sandboxedWorkers: 'default', workerSandbox: 'default' });

    const saved = await invoke(router, 'PUT', '/api/config/execution', { sandboxedWorkers: false, workerSandbox: false });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.execution).toMatchObject({ sandboxedWorkers: false, workerSandbox: false });
    expect(saved.body.executionSources).toMatchObject({ sandboxedWorkers: 'user', workerSandbox: 'user' });

    const persisted = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(persisted.execution).toMatchObject({ sandboxedWorkers: false, workerSandbox: false });
  });

  it('rejects non-boolean Worker settings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-agent-config-api-invalid-'));
    await configStore.init(dir);
    const router = createConfigRouter();

    const response = await invoke(router, 'PUT', '/api/config/execution', { sandboxedWorkers: 'false' });
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toContain('sandboxedWorkers');
  });
});

describe('model admission policy API', () => {
  const sampleModels = () => ([
    { id: 'meta/llama-3.2-11b-vision-instruct', label: 'llama vision', provider: 'nvidia', agentCompatible: false },
    { id: 'deepseek-ai/deepseek-v3', label: 'deepseek', provider: 'nvidia' },
  ]);

  it('exposes the effective policy and the built-in defaults', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-model-policy-api-'));
    await configStore.init(dir);
    const router = createConfigRouter(sampleModels());

    const res = await invoke(router, 'GET', '/api/config');
    expect(res.body.models.nonAgentKeywords).toContain('-vision');
    expect(res.body.models.agentCompatible).toEqual({});
    expect(res.body.modelDefaults.nonAgentKeywords).toContain('-vision');
  });

  it('re-tags the shared modelConfig array in place so no restart is needed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-model-policy-api-retag-'));
    await configStore.init(dir);
    const modelConfig = sampleModels();
    const router = createConfigRouter(modelConfig);

    const res = await invoke(router, 'PUT', '/api/config/models', {
      agentCompatible: { 'meta/llama-3.2-11b-vision-instruct': true },
    });

    expect(res.statusCode).toBe(200);
    // 同一个数组引用被就地改写——agent runner 等持有者才能立刻看到新标记。
    expect(modelConfig[0].agentCompatible).toBe(true);
    expect(modelConfig[1].agentCompatible).toBeUndefined();

    const persisted = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(persisted.models.agentCompatible).toEqual({ 'meta/llama-3.2-11b-vision-instruct': true });
  });

  it('restores the built-in keyword table when nonAgentKeywords is null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-model-policy-api-reset-'));
    await configStore.init(dir);
    const modelConfig = sampleModels();
    const router = createConfigRouter(modelConfig);

    await invoke(router, 'PUT', '/api/config/models', { nonAgentKeywords: [] });
    expect(modelConfig[0].agentCompatible).toBeUndefined();

    const res = await invoke(router, 'PUT', '/api/config/models', { nonAgentKeywords: null });
    expect(res.body.models.nonAgentKeywords).toContain('-vision');
    expect(modelConfig[0].agentCompatible).toBe(false);
  });

  it('leaves untouched fields alone', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-model-policy-api-partial-'));
    await configStore.init(dir);
    const router = createConfigRouter(sampleModels());

    await invoke(router, 'PUT', '/api/config/models', { nonAgentKeywords: ['embed'] });
    const res = await invoke(router, 'PUT', '/api/config/models', { agentCompatible: { 'a/b': true } });

    expect(res.body.models.nonAgentKeywords).toEqual(['embed']);
    expect(res.body.models.agentCompatible).toEqual({ 'a/b': true });
  });

  it('rejects a malformed keyword list', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-model-policy-api-invalid-'));
    await configStore.init(dir);
    const router = createConfigRouter(sampleModels());

    const res = await invoke(router, 'PUT', '/api/config/models', { nonAgentKeywords: 'embed' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('nonAgentKeywords');
  });
});
