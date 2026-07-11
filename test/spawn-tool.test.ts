import { describe, expect, it, vi } from 'vitest';
import { createModelTools } from '../agent/core/tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import { classifyAgentAction } from '../agent/policy/classify.ts';
import { executeSpawnAction } from '../agent/tools/spawn/execute.ts';

describe('Spawn tool exposure', () => {
  it('exposes spawn tool in model tools', () => {
    const names = createModelTools().map(tool => tool.name);
    expect(names).toContain('spawn');
  });

  it('exposes only side-effect-free tools to readonly sub-agents', () => {
    const names = createModelTools({ mode: 'readonly' }).map(tool => tool.name);

    expect(names).toEqual([
      'list_dir',
      'read_file',
      'get_file_info',
      'web_search',
      'image_analyze',
      'search_files',
      'codegraph_query',
      'finish',
    ]);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_safe');
    expect(names).not.toContain('navigate');
    expect(names).not.toContain('chrome_call_tool');
  });

  it('spawn tool has correct schema', () => {
    const tools = createModelTools();
    const spawnTool = tools.find(t => t.name === 'spawn');

    expect(spawnTool).toBeDefined();
    expect(spawnTool?.description).toContain('并行');
    expect(spawnTool?.input_schema.properties.tasks).toBeDefined();
    expect(spawnTool?.input_schema.properties.tasks.type).toBe('array');
    expect(spawnTool?.input_schema.properties.tasks.maxItems).toBe(5);
  });
});

describe('Spawn action normalization', () => {
  it('normalizes spawn action with string tasks', () => {
    const result = normalizeDesktopAgentDecision({
      rationale: '并行分析',
      action: {
        type: 'spawn',
        tasks: ['分析文件A', '分析文件B', '搜索TODO'],
      },
    });

    expect(result.action).toEqual({
      tool: 'spawn',
      type: 'spawn',
      tasks: ['分析文件A', '分析文件B', '搜索TODO'],
    });
  });

  it('filters empty tasks and trims whitespace', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'spawn',
        tasks: ['  task1  ', '', '  task2', null, 'task3', '   '],
      },
    });

    if (result.action.type !== 'spawn') throw new Error('expected spawn action');
    expect(result.action.tasks).toEqual(['task1', 'task2', 'task3']);
  });

  it('caps tasks at 5', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'spawn',
        tasks: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
      },
    });

    if (result.action.type !== 'spawn') throw new Error('expected spawn action');
    expect(result.action.tasks).toHaveLength(5);
    expect(result.action.tasks).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('throws error when tasks array is empty', () => {
    expect(() => {
      normalizeDesktopAgentDecision({
        action: {
          type: 'spawn',
          tasks: [],
        },
      });
    }).toThrow('spawn 缺少有效的 tasks 数组');
  });

  it('throws error when tasks contains only empty strings', () => {
    expect(() => {
      normalizeDesktopAgentDecision({
        action: {
          type: 'spawn',
          tasks: ['', '  ', '   '],
        },
      });
    }).toThrow('spawn 缺少有效的 tasks 数组');
  });
});

describe('Spawn policy classification', () => {
  it('classifies spawn as safe', () => {
    const policy = classifyAgentAction({
      tool: 'spawn',
      type: 'spawn',
      tasks: ['task1', 'task2'],
    });

    expect(policy.level).toBe('safe');
    expect(policy.reason).toContain('并行');
  });
});

describe('Spawn cancellation', () => {
  it('passes the timeout signal to the sub-agent and aborts the underlying task', async () => {
    const runSubAgent = vi.fn((_task, _index, signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

    const result = await executeSpawnAction(
      { type: 'spawn', tasks: ['slow task'] },
      { runSubAgent, timeoutMs: 10 },
    );

    expect(runSubAgent).toHaveBeenCalledTimes(1);
    expect(runSubAgent.mock.calls[0][2].aborted).toBe(true);
    expect(result).toContain('子 Agent 超时');
  });

  it('propagates parent cancellation to every sub-agent', async () => {
    const parent = new AbortController();
    const runSubAgent = vi.fn((_task, _index, signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = executeSpawnAction(
      { type: 'spawn', tasks: ['one', 'two'] },
      { runSubAgent, signal: parent.signal },
    );

    parent.abort(new Error('Agent 已取消'));
    const result = await pending;

    expect(runSubAgent).toHaveBeenCalledTimes(2);
    expect(result.match(/Agent 已取消/g)).toHaveLength(2);
  });
});
