import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { configStore } from '../agent/core/config-store.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import { createModelTools } from '../agent/core/tool-definitions.ts';
import { classifyAgentAction } from '../agent/policy/classify.ts';
import { listGenericMcpServers } from '../agent/tools/mcp/client.ts';
import { buildGenericMcpToolArguments } from '../agent/tools/mcp/execute.ts';

beforeAll(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-generic-mcp-'));
  await configStore.init(dir);
  await configStore.updateMcpServer('codex', {
    enabled: true,
    transport: { type: 'stdio', command: 'codex', args: ['mcp-server'], cwd: '.' },
  });
});

describe('generic MCP adapter', () => {
  it('exposes generic discovery and call tools when a server is enabled', () => {
    const names = createModelTools().map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool']));
    expect(listGenericMcpServers().map(server => server.name)).toContain('codex');
  });

  it('normalizes generic MCP calls', () => {
    expect(normalizeDesktopAgentDecision({
      rationale: '交给 Codex',
      action: {
        type: 'mcp_call_tool',
        serverName: ' codex ',
        toolName: ' codex ',
        arguments: { prompt: '修复测试' },
      },
    }).action).toEqual({
      tool: 'mcp',
      type: 'mcp_call_tool',
      serverName: 'codex',
      toolName: 'codex',
      arguments: { prompt: '修复测试' },
      refreshTools: false,
    });
  });

  it('keeps metadata reads safe and requires confirmation for arbitrary calls', () => {
    expect(classifyAgentAction({ tool: 'mcp', type: 'mcp_list_tools', serverName: 'codex' }).level).toBe('safe');
    expect(classifyAgentAction({ tool: 'mcp', type: 'mcp_call_tool', serverName: 'codex', toolName: 'codex' }).level).toBe('confirm');
  });

  it('starts Codex in the active project without an unreachable nested approval prompt', () => {
    expect(buildGenericMcpToolArguments('codex', 'codex', { prompt: 'inspect' }, '/tmp/project')).toEqual({
      prompt: 'inspect',
      cwd: '/tmp/project',
      'approval-policy': 'never',
      sandbox: 'workspace-write',
    });
    expect(buildGenericMcpToolArguments('other', 'tool', { prompt: 'inspect' }, '/tmp/project')).toEqual({ prompt: 'inspect' });
  });
});
