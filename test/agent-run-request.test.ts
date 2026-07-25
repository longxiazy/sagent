import { describe, expect, it } from 'vitest';
import { parseAgentRunRequest } from '../routes/agent-run-request.ts';

describe('parseAgentRunRequest private browser mode', () => {
  it('normalizes the privateMode flag to a strict boolean', () => {
    expect(parseAgentRunRequest({ task: 'browse', model: 'model-a', privateMode: true })).toMatchObject({ privateMode: true });
    expect(parseAgentRunRequest({ task: 'browse', model: 'model-a' })).toMatchObject({ privateMode: false });
    expect(parseAgentRunRequest({ task: 'browse', model: 'model-a', privateMode: 'true' })).toMatchObject({ privateMode: false });
  });
});
