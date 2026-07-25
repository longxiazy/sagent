import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configStore } from '../agent/core/config-store.ts';

describe('structured configuration store', () => {
  it('migrates legacy runtime-config.json to versioned config.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-migrate-'));
    await writeFile(path.join(dir, 'runtime-config.json'), JSON.stringify({ maxSteps: 33 }));

    await configStore.init(dir);

    expect(configStore.get().maxSteps).toBe(33);
    expect(configStore.sources().maxSteps).toBe('user');
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved).toMatchObject({ version: 1, agent: { maxSteps: 33 }, mcpServers: {} });
  });

  it('persists generic SSE and stdio MCP server entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-mcp-'));
    await configStore.init(dir);

    await configStore.updateMcpServer('chrome', {
      enabled: true,
      transport: { type: 'sse', url: 'http://127.0.0.1:3099/sse' },
      promptMode: 'lazy',
    });
    await configStore.updateMcpServer('filesystem', {
      enabled: true,
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
      toolTimeoutMs: 600000,
    });
    await configStore.updateMcpServer('codex', {
      enabled: true,
      transport: { type: 'stdio', command: 'codex', args: ['mcp-server'] },
    });

    expect(configStore.mcpServers()).toMatchObject({
      chrome: { enabled: true, transport: { type: 'sse' } },
      filesystem: { enabled: true, transport: { type: 'stdio' } },
      codex: { enabled: true, transport: { type: 'stdio' }, toolTimeoutMs: 600000 },
    });
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.mcpServers.chrome.transport.url).toBe('http://127.0.0.1:3099/sse');
    expect(saved.mcpServers.filesystem.transport.command).toBe('npx');
    expect(saved.mcpServers.filesystem.toolTimeoutMs).toBe(600000);
  });

  it('resets a profile durably while preserving other config sections', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-reset-'));
    await configStore.init(dir);
    await configStore.applyProfile('deep');
    await configStore.updateMcpServer('chrome', {
      enabled: false,
      transport: { type: 'sse', url: 'http://127.0.0.1:3099/sse' },
    });

    await configStore.reset();

    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.profile).toBe('custom');
    expect(saved.agent).toEqual({});
    expect(saved.mcpServers.chrome.transport.url).toBe('http://127.0.0.1:3099/sse');

    await configStore.init(dir);
    expect(configStore.document().profile).toBe('custom');
    expect(configStore.get()).toEqual(configStore.defaults());
  });

  it('defaults to sandboxed workers when execution mode is not configured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-execution-default-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }));
    await configStore.init(dir);

    expect(configStore.execution({}).sandboxedWorkers).toBe(true);
    // sandboxedWorkers 由存储配置决定，不受环境变量影响。
    expect(configStore.execution({ AGENT_SANDBOXED_WORKERS: 'false' }).sandboxedWorkers).toBe(true);
  });

  it('ignores AGENT_SANDBOXED_WORKERS and honors only the stored execution mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-execution-'));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      version: 1,
      execution: { sandboxedWorkers: false, workerSandbox: false, resume: false },
    }));
    await configStore.init(dir);

    expect(configStore.execution({})).toEqual({
      sandboxedWorkers: false,
      workerSandbox: false,
      resume: false,
    });
    // AGENT_SANDBOXED_WORKERS 不再被接受；仅 workerSandbox/resume 仍支持环境变量覆盖。
    expect(configStore.execution({
      AGENT_SANDBOXED_WORKERS: 'true',
      AGENT_WORKER_SANDBOX: 'true',
      AGENT_RESUME: 'true',
    })).toEqual({
      sandboxedWorkers: false,
      workerSandbox: true,
      resume: true,
    });
  });

  it('persists Worker execution settings and validates boolean values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-execution-update-'));
    await configStore.init(dir);

    await configStore.updateExecution({ sandboxedWorkers: false, workerSandbox: false });

    expect(configStore.execution({})).toMatchObject({
      sandboxedWorkers: false,
      workerSandbox: false,
    });
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.execution).toMatchObject({ sandboxedWorkers: false, workerSandbox: false });

    await configStore.init(dir);
    expect(configStore.execution({})).toMatchObject({
      sandboxedWorkers: false,
      workerSandbox: false,
    });

    await expect(configStore.updateExecution({ sandboxedWorkers: 'false' as any })).rejects.toThrow('sandboxedWorkers');
  });
});
