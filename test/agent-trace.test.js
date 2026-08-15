import { describe, expect, it } from 'vitest';
import { agentTraceEventKey, appendUniqueTraceEvent, latestTerminalEvent, settledTerminalEvent } from '../client/src/utils/agent-trace.js';

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

// 从 checkpoint 重跑复用 runId，同一条 trace 里会留下每个 attempt 的终止事件。
// 线上实证：run_msnf1e7m_1aqeta 的 attempt 1/2 各有一个 error、attempt 3 是 done，
// 但会话里被写成了 "Desktop Agent failed"——取首个终止事件导致成功被记成失败。
describe('terminal event selection across retry attempts', () => {
  it('picks the last terminal event, not the first', () => {
    const events = [
      { type: 'step', attempt: 1, step: 7, stage: 'observe' },
      { type: 'error', attempt: 1, error: '模型动作解析失败' },
      { type: 'step', attempt: 2, step: 9, stage: 'observe' },
      { type: 'error', attempt: 2, error: '模型动作解析失败' },
      { type: 'step', attempt: 3, step: 12, stage: 'result' },
      { type: 'done', attempt: 3, answer: '已成功生成 dashboard.html' },
    ];

    const terminal = latestTerminalEvent(events);

    expect(terminal.type).toBe('done');
    expect(terminal.answer).toBe('已成功生成 dashboard.html');
  });

  it('still reports a genuine failure when the last attempt failed', () => {
    const events = [
      { type: 'done', attempt: 1, answer: 'old success' },
      { type: 'error', attempt: 2, error: 'Agent 已取消' },
    ];

    expect(latestTerminalEvent(events)).toMatchObject({ type: 'error', error: 'Agent 已取消' });
  });

  it('returns null when the run has not finished', () => {
    expect(latestTerminalEvent([{ type: 'step', step: 1 }])).toBeNull();
    expect(latestTerminalEvent(null)).toBeNull();
  });
});

// 切 tab 回来时的兜底只能用「已定局」的终止事件收尾。重跑跑到一半时 trace 里
// 最后一个终止事件仍是上一次 attempt 的失败，据此收尾会在任务正跑着时误报失败、
// 清掉运行态和待审批弹窗，而后端还在继续执行。
describe('settled terminal event guards in-flight retries', () => {
  it('ignores the previous attempt failure while a newer attempt is running', () => {
    const events = [
      { type: 'step', attempt: 1, step: 1, stage: 'result' },
      { type: 'error', attempt: 1, error: '模型超时 (120s)' },
      { type: 'run_meta', attempt: 2 },
      { type: 'step', attempt: 2, step: 2, stage: 'observe' },
    ];

    expect(latestTerminalEvent(events)).toMatchObject({ type: 'error', attempt: 1 });
    expect(settledTerminalEvent(events)).toBeNull();
  });

  it('accepts the terminal event once the newest attempt finishes', () => {
    const events = [
      { type: 'error', attempt: 1, error: '模型超时 (120s)' },
      { type: 'run_meta', attempt: 2 },
      { type: 'done', attempt: 2, answer: '完成' },
    ];

    expect(settledTerminalEvent(events)).toMatchObject({ type: 'done', answer: '完成' });
  });

  it('treats traces without attempt fields as a single attempt', () => {
    const events = [
      { type: 'step', step: 1, stage: 'result' },
      { type: 'done', answer: '完成' },
    ];

    expect(settledTerminalEvent(events)).toMatchObject({ type: 'done', answer: '完成' });
  });

  it('returns null when nothing has finished yet', () => {
    expect(settledTerminalEvent([{ type: 'step', step: 1 }])).toBeNull();
    expect(settledTerminalEvent(null)).toBeNull();
  });
});
