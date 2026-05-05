import { afterEach, describe, expect, it } from 'vitest';
import { createModelTools } from '../agent/core/tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import { classifyAgentAction } from '../agent/policy/classify.ts';
import {
  applyIdeToolDefaults,
  buildSsePostCandidates,
  loadIdeMcpConfig,
  resetIdeMcpClientForTests,
} from '../agent/tools/ide/mcp-client.ts';

const ORIGINAL_ENV = { ...process.env };

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await resetIdeMcpClientForTests();
});

describe('IDE MCP tool exposure', () => {
  it('does not expose IDE tools when IDE MCP is disabled', () => {
    delete process.env.IDE_MCP_ENABLED;
    delete process.env.IDE_MCP_TRANSPORT;
    delete process.env.IDE_MCP_URL;

    const names = createModelTools().map(tool => tool.name);

    expect(names).not.toContain('ide_list_tools');
    expect(names).not.toContain('ide_call_tool');
  });

  it('exposes IDE tools when IDE MCP is enabled', () => {
    process.env.IDE_MCP_ENABLED = 'true';

    const names = createModelTools().map(tool => tool.name);

    expect(names).toContain('ide_list_tools');
    expect(names).toContain('ide_call_tool');
  });
});

describe('IDE MCP action normalization', () => {
  it('normalizes ide_call_tool payloads', () => {
    const result = normalizeDesktopAgentDecision({
      rationale: '调用 IDE',
      action: {
        type: 'ide_call_tool',
        toolName: ' get_run_configurations ',
        arguments: { timeout: 5000 },
        refreshTools: 1,
      },
    });

    expect(result.action).toEqual({
      tool: 'ide',
      type: 'ide_call_tool',
      toolName: 'get_run_configurations',
      arguments: { timeout: 5000 },
      refreshTools: true,
    });
  });

  it('normalizes ide_list_tools payloads', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'ide_list_tools',
        refresh: 'yes',
      },
    });

    expect(result.action).toEqual({
      tool: 'ide',
      type: 'ide_list_tools',
      refresh: true,
    });
  });
});

describe('IDE MCP policy classification', () => {
  it('treats read-only IDE calls as safe', () => {
    expect(classifyAgentAction({
      tool: 'ide',
      type: 'ide_call_tool',
      toolName: 'get_file_problems',
    }).level).toBe('safe');
  });

  it('requires confirmation for mutating IDE calls', () => {
    expect(classifyAgentAction({
      tool: 'ide',
      type: 'ide_call_tool',
      toolName: 'rename_refactoring',
    }).level).toBe('confirm');
  });
});

describe('IDE MCP config helpers', () => {
  it('loads SSE defaults and project path', () => {
    process.env.IDE_MCP_ENABLED = 'true';
    process.env.IDE_PROJECT_PATH = './test-project';

    const config = loadIdeMcpConfig();

    expect(config.transport).toBe('sse');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(6365);
    expect(config.projectPath).toMatch(/test-project$/);
  });

  it('auto-fills projectPath for tools that support it', () => {
    process.env.IDE_MCP_ENABLED = 'true';
    process.env.IDE_PROJECT_PATH = '/tmp/demo-project';

    const args = applyIdeToolDefaults(
      { filePath: 'src/app.ts' },
      {
        name: 'get_file_problems',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            projectPath: { type: 'string' },
          },
        },
      },
      loadIdeMcpConfig()
    );

    expect(args).toEqual({
      filePath: 'src/app.ts',
      projectPath: '/tmp/demo-project',
    });
  });

  it('builds SSE post endpoint fallbacks for JetBrains-compatible servers', () => {
    const candidates = buildSsePostCandidates(
      { messagesUrl: null },
      'http://127.0.0.1:64342/sse'
    );

    expect(candidates).toEqual([
      'http://127.0.0.1:64342/message',
      'http://127.0.0.1:64342/messages',
      'http://127.0.0.1:64342/mcp',
    ]);
  });
});
