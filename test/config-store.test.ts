import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeConfig } from '../agent/core/runtime-config.ts';

describe('structured configuration store', () => {
  it('migrates legacy runtime-config.json to versioned config.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-migrate-'));
    await writeFile(path.join(dir, 'runtime-config.json'), JSON.stringify({ maxSteps: 33 }));

    await runtimeConfig.init(dir);

    expect(runtimeConfig.get().maxSteps).toBe(33);
    expect(runtimeConfig.sources().maxSteps).toBe('user');
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved).toMatchObject({ version: 1, agent: { maxSteps: 33 }, mcpServers: {} });
  });

  it('persists generic SSE and stdio MCP server entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-mcp-'));
    await runtimeConfig.init(dir);

    await runtimeConfig.updateMcpServer('chrome', {
      enabled: true,
      transport: { type: 'sse', url: 'http://127.0.0.1:3099/sse' },
      promptMode: 'lazy',
    });
    await runtimeConfig.updateMcpServer('jetbrains', {
      enabled: true,
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@jetbrains/mcp-proxy'] },
      projectPath: '.',
    });

    expect(runtimeConfig.mcpServers()).toMatchObject({
      chrome: { enabled: true, transport: { type: 'sse' } },
      jetbrains: { enabled: true, transport: { type: 'stdio' } },
    });
    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.mcpServers.chrome.transport.url).toBe('http://127.0.0.1:3099/sse');
    expect(saved.mcpServers.jetbrains.transport.command).toBe('npx');
  });

  it('resets a profile durably while preserving other config sections', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-config-reset-'));
    await runtimeConfig.init(dir);
    await runtimeConfig.applyProfile('deep');
    await runtimeConfig.updateMcpServer('chrome', {
      enabled: false,
      transport: { type: 'sse', url: 'http://127.0.0.1:3099/sse' },
    });

    await runtimeConfig.reset();

    const saved = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(saved.profile).toBe('custom');
    expect(saved.agent).toEqual({});
    expect(saved.mcpServers.chrome.transport.url).toBe('http://127.0.0.1:3099/sse');

    await runtimeConfig.init(dir);
    expect(runtimeConfig.document().profile).toBe('custom');
    expect(runtimeConfig.get()).toEqual(runtimeConfig.defaults());
  });
});
