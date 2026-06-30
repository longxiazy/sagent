import { describe, expect, it } from 'vitest';
import { computeTraceMetrics, formatDurationMs } from '../client/src/components/agent/trace-metrics.js';

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
});
