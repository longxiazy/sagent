import { afterEach, describe, expect, it } from 'vitest';
import { createModelTools } from '../agent/core/tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import { classifyAgentAction } from '../agent/policy/classify.ts';
import { executeChromeAction } from '../agent/tools/chrome/execute.ts';
import {
  isChromeMcpAvailable,
  loadChromeMcpConfig,
  markChromeMcpUnavailable,
  resetChromeMcpClientForTests,
} from '../agent/tools/chrome/mcp-client.ts';

const ORIGINAL_ENV = { ...process.env };

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await resetChromeMcpClientForTests();
});

describe('Chrome MCP tool exposure', () => {
  it('does not expose Chrome tools when Chrome MCP is disabled', () => {
    delete process.env.CHROME_MCP_ENABLED;
    delete process.env.CHROME_MCP_TRANSPORT;
    delete process.env.CHROME_MCP_URL;

    const names = createModelTools().map(tool => tool.name);

    expect(names).not.toContain('chrome_list_tools');
    expect(names).not.toContain('chrome_call_tool');
  });

  it('exposes Chrome tools when Chrome MCP is enabled', () => {
    process.env.CHROME_MCP_ENABLED = 'true';

    const names = createModelTools().map(tool => tool.name);

    expect(names).toContain('chrome_list_tools');
    expect(names).toContain('chrome_call_tool');
  });

  it('stops exposing Chrome tools after the MCP endpoint is marked unreachable', async () => {
    process.env.CHROME_MCP_ENABLED = 'true';
    expect(isChromeMcpAvailable()).toBe(true);

    markChromeMcpUnavailable(60_000);

    const names = createModelTools().map(tool => tool.name);
    expect(isChromeMcpAvailable()).toBe(false);
    expect(names).not.toContain('chrome_list_tools');
    expect(names).not.toContain('chrome_call_tool');
    await expect(executeChromeAction({
      type: 'chrome_call_tool',
      toolName: 'list_pages',
      arguments: {},
      refreshTools: false,
    })).rejects.toThrow('Chrome MCP 当前不可达');
  });
});

describe('Chrome MCP action normalization', () => {
  it('normalizes chrome_call_tool payloads', () => {
    const result = normalizeDesktopAgentDecision({
      rationale: '调用 Chrome 工具',
      action: {
        type: 'chrome_call_tool',
        toolName: ' take_screenshot ',
        arguments: { format: 'png' },
        refreshTools: 1,
      },
    });

    expect(result.action).toEqual({
      tool: 'chrome',
      type: 'chrome_call_tool',
      toolName: 'take_screenshot',
      arguments: { format: 'png' },
      refreshTools: true,
    });
  });

  it('normalizes chrome_list_tools payloads', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'chrome_list_tools',
        refresh: 'yes',
      },
    });

    expect(result.action).toEqual({
      tool: 'chrome',
      type: 'chrome_list_tools',
      refresh: true,
    });
  });

  it('normalizes chrome_call alias', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'chrome_call',
        toolName: 'click',
        arguments: { uid: 'abc123' },
      },
    });

    expect(result.action.type).toBe('chrome_call_tool');
    if (result.action.type !== 'chrome_call_tool') throw new Error('expected chrome_call_tool');
    expect(result.action.toolName).toBe('click');
  });
});

describe('Chrome MCP policy classification', () => {
  it('treats chrome_list_tools as safe', () => {
    const result = classifyAgentAction({
      tool: 'chrome',
      type: 'chrome_list_tools',
    });

    expect(result.level).toBe('safe');
  });

  it('treats known read-only Chrome tools as safe', () => {
    for (const toolName of ['take_snapshot', 'take_screenshot', 'list_pages', 'list_console_messages']) {
      const result = classifyAgentAction({
        tool: 'chrome',
        type: 'chrome_call_tool',
        toolName,
      });
      expect(result.level).toBe('safe');
    }
  });

  it('treats browser-only interactions (open/click/type/scroll) as safe', () => {
    for (const toolName of ['click', 'fill', 'navigate_page', 'press_key', 'new_page', 'type_text']) {
      const result = classifyAgentAction({
        tool: 'chrome',
        type: 'chrome_call_tool',
        toolName,
      });
      expect(result.level).toBe('safe');
    }
  });

  it('keeps high-risk Chrome tools (arbitrary JS, file upload) as confirm', () => {
    for (const toolName of ['evaluate_script', 'upload_file']) {
      const result = classifyAgentAction({
        tool: 'chrome',
        type: 'chrome_call_tool',
        toolName,
      });
      expect(result.level).toBe('confirm');
    }
  });

  it('treats unknown Chrome tools as confirm', () => {
    const result = classifyAgentAction({
      tool: 'chrome',
      type: 'chrome_call_tool',
      toolName: 'some_unknown_tool',
    });

    expect(result.level).toBe('confirm');
  });
});

describe('Chrome MCP config', () => {
  it('loads defaults when disabled', () => {
    delete process.env.CHROME_MCP_ENABLED;
    const config = loadChromeMcpConfig();

    expect(config.enabled).toBe(false);
    expect(config.transport).toBe('sse');
    expect(config.port).toBe(3099);
  });

  it('detects enabled via CHROME_MCP_ENABLED', () => {
    process.env.CHROME_MCP_ENABLED = 'true';
    const config = loadChromeMcpConfig();

    expect(config.enabled).toBe(true);
  });
});

describe('Chrome MCP search-engine guard', () => {
  it('blocks search engine navigation before connecting to MCP', async () => {
    process.env.CHROME_MCP_ENABLED = 'true';

    const result = await executeChromeAction({
      type: 'chrome_call_tool',
      toolName: 'navigate_page',
      arguments: { url: 'https://www.baidu.com/s?wd=杭州必去十大景点' },
    });

    expect(result).toContain('已阻止访问搜索引擎搜索页');
  });
});
