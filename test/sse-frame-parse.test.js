import { describe, expect, it } from 'vitest';
import { parseSseFrame } from '../client/src/api/streams.js';

// 重连回放会在 data: 之前加一行 `id: <seq>` 当游标(routes/agent-run-control.ts
// writeSseEvent / helpers/agent-logging.ts buildSseWriter)。历史上重连解析器用
// /^data:\s*/ 锚定整帧，于是每个带 seq 的事件都解析失败并被 catch 静默丢弃——
// 表现为“刷新后能接回运行，但 Agent 面板再也不更新”。
describe('SSE frame parsing', () => {
  it('reads events from frames that carry an id: cursor line', () => {
    const frame = 'id: 4\ndata: {"type":"step","seq":4,"stage":"result"}';

    expect(parseSseFrame(frame)).toEqual({ type: 'step', seq: 4, stage: 'result' });
  });

  it('reads events from frames without an id: line', () => {
    const frame = 'data: {"type":"run_meta","runId":"run_1"}';

    expect(parseSseFrame(frame)).toEqual({ type: 'run_meta', runId: 'run_1' });
  });

  it('ignores heartbeat comment frames', () => {
    expect(parseSseFrame(': heartbeat')).toBeNull();
  });

  it('ignores the [DONE] sentinel', () => {
    expect(parseSseFrame('id: 9\ndata: [DONE]')).toBeNull();
  });

  it('parses a whole replayed stream, not just the frame without a cursor', () => {
    const raw = [
      'data: {"type":"run_meta","runId":"run_1"}',
      'id: 1\ndata: {"type":"status","seq":1,"status":"starting"}',
      'id: 2\ndata: {"type":"step","seq":2,"stage":"observe"}',
      ': heartbeat',
      'id: 3\ndata: {"type":"done","seq":3,"answer":"ok"}',
    ].join('\n\n');

    const events = raw
      .split('\n\n')
      .map(frame => parseSseFrame(frame))
      .filter(Boolean);

    expect(events.map(event => event.type)).toEqual(['run_meta', 'status', 'step', 'done']);
  });
});
