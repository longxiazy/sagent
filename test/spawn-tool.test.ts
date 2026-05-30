import { describe, expect, it } from 'vitest';
import { createModelTools } from '../agent/core/tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import { classifyAgentAction } from '../agent/policy/classify.ts';

describe('Spawn tool exposure', () => {
  it('exposes spawn tool in model tools', () => {
    const names = createModelTools().map(tool => tool.name);
    expect(names).toContain('spawn');
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

    expect(result.action.tasks).toEqual(['task1', 'task2', 'task3']);
  });

  it('caps tasks at 5', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'spawn',
        tasks: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
      },
    });

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
