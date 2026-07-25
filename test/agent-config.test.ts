import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentConfigRouter } from '../routes/agent-config.ts';
import { configStore } from '../agent/core/config-store.ts';

function createConfigRouter() {
  return createAgentConfigRouter({
    configStore,
    projectStore: { dataDir: () => '' },
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
