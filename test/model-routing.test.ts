import { describe, expect, it } from 'vitest';
import { estimateTaskComplexity, routeAgentModels, scoreModelForRouting } from '../agent/core/model-routing.ts';

const modelConfig = [
  {
    id: 'models/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'gemini',
    description: 'Fast efficient model',
    contextWindow: 1_000_000,
  },
  {
    id: 'openai/o3',
    label: 'o3',
    provider: 'openai',
    description: 'Strong reasoning model',
    contextWindow: 200_000,
  },
  {
    id: 'meta/llama-3.1-8b-instruct',
    label: 'Llama 8B',
    provider: 'nvidia',
    description: 'Small instruct model',
    contextWindow: 128_000,
  },
];

describe('model routing', () => {
  it('classifies simple lookup tasks as low complexity', () => {
    expect(estimateTaskComplexity({ task: '查一下 README 里写了什么' })).toMatchObject({
      complexity: 'low',
      reason: 'task-keyword',
    });
  });

  it('classifies refactors as high complexity', () => {
    expect(estimateTaskComplexity({ task: '重构多文件模型选择逻辑并补测试' })).toMatchObject({
      complexity: 'high',
      reason: 'task-keyword',
    });
  });

  it('escalates after recent failures', () => {
    expect(estimateTaskComplexity({
      task: '继续修复',
      history: [{ resultStatus: 'failed', result: '执行失败: test failed' }],
    })).toMatchObject({
      complexity: 'high',
      reason: 'recent-failure',
    });
  });

  it('scores flash-style models as more economical than strongest models', () => {
    expect(scoreModelForRouting('models/gemini-2.5-flash', modelConfig).economy)
      .toBeGreaterThan(scoreModelForRouting('openai/o3', modelConfig).economy);
  });

  it('routes simple tasks to cheaper selected models first', () => {
    const routed = routeAgentModels({
      enabled: true,
      primaryModel: 'openai/o3',
      agentModels: ['openai/o3', 'models/gemini-2.5-flash'],
      modelConfig,
      task: '搜索一下这个报错是什么意思',
    });

    expect(routed.complexity).toBe('low');
    expect(routed.models[0]).toBe('models/gemini-2.5-flash');
  });

  it('routes complex tasks to stronger selected models first', () => {
    const routed = routeAgentModels({
      enabled: true,
      primaryModel: 'models/gemini-2.5-flash',
      agentModels: ['models/gemini-2.5-flash', 'openai/o3'],
      modelConfig,
      task: '分析架构并重构多文件实现',
    });

    expect(routed.complexity).toBe('high');
    expect(routed.models[0]).toBe('openai/o3');
  });

  it('keeps order when disabled or medium complexity', () => {
    expect(routeAgentModels({
      enabled: false,
      primaryModel: 'openai/o3',
      agentModels: ['openai/o3', 'models/gemini-2.5-flash'],
      modelConfig,
      task: '搜索一下这个报错是什么意思',
    }).models).toEqual(['openai/o3', 'models/gemini-2.5-flash']);

    expect(routeAgentModels({
      enabled: true,
      primaryModel: 'openai/o3',
      agentModels: ['openai/o3', 'models/gemini-2.5-flash'],
      modelConfig,
      task: '帮我处理这个任务',
    }).models).toEqual(['openai/o3', 'models/gemini-2.5-flash']);
  });
});
