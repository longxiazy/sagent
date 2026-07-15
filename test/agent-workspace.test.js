import { describe, expect, it } from 'vitest';
import { lastUserMessageIndex } from '../client/src/utils/agent-workspace.js';

describe('agent workspace timeline placement', () => {
  it('places the agent trace after the latest user task', () => {
    const messages = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second task' },
      { role: 'assistant', content: 'running', pending: 'run' },
    ];

    expect(lastUserMessageIndex(messages)).toBe(2);
  });

  it('handles sessions without a user message', () => {
    expect(lastUserMessageIndex([])).toBe(-1);
    expect(lastUserMessageIndex([{ role: 'assistant', content: 'restored' }])).toBe(-1);
  });
});
