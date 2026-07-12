import { describe, expect, it } from 'vitest';
import { computeModelTraceMetrics, computeTraceMetrics, formatDurationMs, traceModelIds } from '../client/src/components/agent/trace-metrics.js';

describe('trace metrics', () => {
  it('keeps the existing model-plan token de-duplication while adding observability metrics', () => {
    const trace = [
      { type: 'step', step: 1, stage: 'observe', timestamp: 1000 },
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1', 'm2'], timestamp: 1100 },
      { type: 'model_plan', step: 1, stage: 'success', model: 'm1', usage: { prompt_tokens: 10, completion_tokens: 2 }, timestamp: 1800 },
      { type: 'model_plan', step: 1, stage: 'success', model: 'm2', usage: { prompt_tokens: 12, completion_tokens: 3 }, timestamp: 1900 },
      { type: 'step', step: 1, stage: 'action', action: { tool: 'fs', type: 'read_file' }, usage: { prompt_tokens: 10, completion_tokens: 2 }, timestamp: 2000 },
      { type: 'step', step: 1, stage: 'result', result: 'ok', timestamp: 2600 },
      { type: 'done', meta: { elapsed_ms: 1700, step_count: 1 }, timestamp: 2700 },
    ];

    const metrics = computeTraceMetrics(trace);

    expect(metrics.totalTokens).toBe(27);
    expect(metrics.llmCalls).toBe(2);
    expect(metrics.completedToolCalls).toBe(1);
    expect(metrics.toolSuccesses).toBe(1);
    expect(metrics.toolSuccessRate).toBe(1);
    expect(metrics.totalDurationMs).toBe(1700);
    expect(metrics.stepDurations[0]).toMatchObject({
      step: 1,
      durationMs: 1600,
      status: 'fast',
      tokens: 27,
      tool: 'fs',
    });
  });

  it('marks failed tool results and slow steps for the debug panel', () => {
    const trace = [
      { type: 'step', step: 1, stage: 'observe', timestamp: 0 },
      { type: 'model_plan', step: 1, stage: 'winner', model: 'm1', usage: { prompt_tokens: 1, completion_tokens: 1 }, timestamp: 1000 },
      { type: 'step', step: 1, stage: 'action', action: { tool: 'browser', type: 'navigate' }, timestamp: 2000 },
      { type: 'step', step: 1, stage: 'result', result: '导航超时', timestamp: 13000 },
    ];

    const metrics = computeTraceMetrics(trace);

    expect(metrics.toolFailures).toBe(1);
    expect(metrics.toolSuccessRate).toBe(0);
    expect(metrics.slowestStep).toMatchObject({ step: 1, status: 'failed' });
    expect(formatDurationMs(metrics.slowestStep.durationMs)).toBe('13s');
  });

  it('prefers structured resultStatus over legacy keyword matching', () => {
    const trace = [
      { type: 'step', step: 1, stage: 'observe', timestamp: 0 },
      { type: 'step', step: 1, stage: 'action', action: { tool: 'fs', type: 'search_files' }, timestamp: 100 },
      { type: 'step', step: 1, stage: 'result', result: '未找到明显问题', resultStatus: 'success', timestamp: 200 },
      { type: 'step', step: 2, stage: 'observe', timestamp: 300 },
      { type: 'step', step: 2, stage: 'action', action: { tool: 'terminal', type: 'run_safe' }, timestamp: 400 },
      { type: 'step', step: 2, stage: 'result', result: 'process exited', resultStatus: 'failed', timestamp: 500 },
    ];

    const metrics = computeTraceMetrics(trace);

    expect(metrics.toolFailures).toBe(1);
    expect(metrics.stepDurations.map(step => [step.step, step.status])).toEqual([
      [1, 'fast'],
      [2, 'failed'],
    ]);
  });

  it('collects models and keeps per-model decision metrics separate', () => {
    const trace = [
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1', 'm2'] },
      { type: 'model_plan', step: 1, stage: 'success', model: 'm1', duration_ms: 100, usage: { prompt_tokens: 10, completion_tokens: 2 }, action: { type: 'search' } },
      { type: 'model_plan', step: 1, stage: 'failed', model: 'm2', duration_ms: 300, usage: { prompt_tokens: 20, completion_tokens: 3 } },
      { type: 'model_plan', step: 1, stage: 'consensus', model: 'm1', consensus: { allResults: [{ model: 'm1' }, { model: 'm2' }] } },
      { type: 'model_plan', step: 2, stage: 'winner', model: 'm2', duration_ms: 500, usage: { prompt_tokens: 5, completion_tokens: 5 } },
    ];

    expect(traceModelIds(trace)).toEqual(['m1', 'm2']);
    expect(computeModelTraceMetrics(trace)).toEqual([
      expect.objectContaining({ modelId: 'm1', llmCalls: 1, totalTokens: 12, wins: 1, failures: 0, avgDurationMs: 100 }),
      expect.objectContaining({ modelId: 'm2', llmCalls: 2, totalTokens: 33, wins: 1, failures: 1, avgDurationMs: 400 }),
    ]);
  });
});
