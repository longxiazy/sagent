import { describe, expect, it } from 'vitest';
import { agentTraceEventKey, appendUniqueTraceEvent } from '../client/src/utils/agent-trace.js';

describe('agent trace event de-duplication', () => {
  it('uses the server sequence as the primary event identity', () => {
    const first = { runId: 'run_1', seq: 4, type: 'step', step: 1, stage: 'action' };
    const replay = { ...first, timestamp: 999 };

    expect(agentTraceEventKey(first)).toBe('run_1:seq:4');
    expect(appendUniqueTraceEvent([first], replay)).toHaveLength(1);
  });

  it('keeps distinct terminal output events from the same step', () => {
    const events = [
      { type: 'terminal_output', step: 2, phase: 'start', sequence: 1 },
      { type: 'terminal_output', step: 2, phase: 'stdout', sequence: 2, chunk: 'one\n' },
      { type: 'terminal_output', step: 2, phase: 'stderr', sequence: 3, chunk: 'warn\n' },
      { type: 'terminal_output', step: 2, phase: 'exit', sequence: 4, exitCode: 0 },
    ];

    const trace = events.reduce((acc, event) => appendUniqueTraceEvent(acc, event), []);

    expect(trace).toHaveLength(4);
    expect(trace.map(event => event.phase)).toEqual(['start', 'stdout', 'stderr', 'exit']);
  });

  it('deduplicates replayed terminal output events by sequence', () => {
    const first = { type: 'terminal_output', step: 1, phase: 'stdout', sequence: 7, chunk: 'same\n' };
    const replay = { ...first };

    expect(appendUniqueTraceEvent([first], replay)).toHaveLength(1);
    expect(agentTraceEventKey(first)).toBe('terminal_output:1:7');
  });

  it('keeps existing event dedupe behavior for normal trace events', () => {
    const action = { type: 'step', step: 1, stage: 'action', model: 'm1' };
    const replay = { ...action };

    expect(appendUniqueTraceEvent([action], replay)).toHaveLength(1);
  });
});
