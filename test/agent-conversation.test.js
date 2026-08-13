import { describe, expect, it } from 'vitest';
import { buildRunConversationHistory } from '../client/src/utils/agent-conversation.js';

const PRIOR = [
  { role: 'user', content: '第一轮问题' },
  { role: 'assistant', content: '第一轮回答' },
];

describe('agent run conversation history', () => {
  it('takes the whole list on a first run (task is not in messages yet)', () => {
    expect(buildRunConversationHistory(PRIOR, { isRetry: false, task: '第二轮任务' })).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);
  });

  it('keeps prior turns on a checkpoint retry instead of dropping them', () => {
    const messages = [
      ...PRIOR,
      { role: 'user', content: '第二轮任务' },
      { role: 'assistant', content: 'Agent 运行中', pending: 'run' },
    ];

    expect(buildRunConversationHistory(messages, { isRetry: true, task: '第二轮任务' })).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);
  });

  it('cuts at the latest occurrence when the same task text was sent before', () => {
    const messages = [
      { role: 'user', content: '重复任务' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '重复任务' },
      { role: 'assistant', content: '重试中', pending: 'run' },
    ];

    expect(buildRunConversationHistory(messages, { isRetry: true, task: '重复任务' })).toEqual([
      { role: 'user', content: '重复任务' },
      { role: 'assistant', content: '旧回答' },
    ]);
  });

  it('falls back to dropping pending placeholders when the task text does not match', () => {
    const messages = [
      ...PRIOR,
      { role: 'assistant', content: 'Agent 运行中', pending: 'run' },
    ];

    expect(buildRunConversationHistory(messages, { isRetry: true, task: '继续任务' })).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);
  });

  it('caps history at the most recent 10 messages', () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({ role: 'user', content: `m${index}` }));
    const history = buildRunConversationHistory(messages, { isRetry: false });

    expect(history).toHaveLength(10);
    expect(history[0].content).toBe('m4');
    expect(history.at(-1).content).toBe('m13');
  });

  it('tolerates a missing message list', () => {
    expect(buildRunConversationHistory(undefined, { isRetry: true, task: 'x' })).toEqual([]);
  });
});
