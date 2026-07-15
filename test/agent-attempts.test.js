import { describe, expect, it } from 'vitest';
import { buildAttemptTraceIndex } from '../client/src/utils/agent-attempts.js';
import { nextAgentAttempt } from '../routes/agent-run-start.ts';

describe('agent trace attempt boundaries', () => {
  it('increments attempts when a checkpoint retry reuses a run id', () => {
    expect(nextAgentAttempt([])).toBe(1);
    expect(nextAgentAttempt([{ type: 'run_meta' }])).toBe(2);
    expect(nextAgentAttempt([
      { type: 'run_meta', attempt: 1 },
      { type: 'run_meta', attempt: 2 },
    ])).toBe(3);
  });

  it('infers attempts from legacy run_meta boundaries and isolates repeated step numbers', () => {
    const trace = [
      { type: 'run_meta', runId: 'run_1' },
      { type: 'step', step: 1, stage: 'observe', marker: 'first-observe' },
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1'] },
      { type: 'model_plan', step: 1, stage: 'failed', model: 'm1' },
      { type: 'error', error: 'timeout' },
      { type: 'run_meta', runId: 'run_1' },
      { type: 'step', step: 1, stage: 'observe', marker: 'retry-observe' },
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1'] },
      { type: 'model_plan', step: 1, stage: 'success', model: 'm1' },
      { type: 'step', step: 1, stage: 'action', marker: 'retry-action' },
    ];

    const index = buildAttemptTraceIndex(trace);

    expect(index.entries.map(entry => entry.attempt)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(index.eventsByStep.get('1:1').map(event => event.marker).filter(Boolean)).toEqual(['first-observe']);
    expect(index.eventsByStep.get('2:1').map(event => event.marker).filter(Boolean)).toEqual(['retry-observe', 'retry-action']);
    expect(index.observeAnchorIndexByStep.get('1:1')).toBe(1);
    expect(index.observeAnchorIndexByStep.get('2:1')).toBe(6);
  });

  it('uses explicit attempt metadata when reconnect streams omit run_meta events', () => {
    const trace = [
      { type: 'status', status: 'starting', attempt: 2 },
      { type: 'step', step: 1, stage: 'observe', attempt: 2 },
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1'], attempt: 2 },
    ];

    const index = buildAttemptTraceIndex(trace);

    expect(index.latestAttempt).toBe(2);
    expect(index.firstEventIndexByAttempt.get(2)).toBe(0);
    expect(index.eventsByStep.has('2:1')).toBe(true);
  });

  it('selects only the first observe and plan start as render anchors inside an attempt', () => {
    const trace = [
      { type: 'step', step: 1, stage: 'observe', attempt: 1 },
      { type: 'step', step: 1, stage: 'observe', attempt: 1 },
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1', 'm2'], attempt: 1 },
      { type: 'model_plan', step: 1, stage: 'start', models: ['m1', 'm2'], attempt: 1 },
    ];

    const index = buildAttemptTraceIndex(trace);

    expect(index.observeAnchorIndexByStep.get('1:1')).toBe(0);
    expect(index.planAnchorIndexByStep.get('1:1')).toBe(2);
  });
});
