import { describe, expect, it } from 'vitest';
import {
  classifyToolFailure,
  registerToolFailureClassifier,
} from '../agent/core/tool-failure.ts';

const action = { tool: 'search', type: 'web_search', query: 'test', maxResults: 5 } as const;

describe('tool failure classification', () => {
  it.each([
    ['request timed out', 'transient', 'retry_same'],
    ['HTTP 429 rate limit exceeded', 'rate_limit', 'retry_later'],
    ['MCP error -32000: Connection closed', 'session', 'reconnect_then_retry'],
    ['permission denied', 'permission', 'request_permission'],
    ['invalid parameter: query', 'invalid_input', 'revise_action'],
    ['tool is not available', 'unavailable', 'switch_tool'],
  ])('classifies %s', async (message, category, recovery) => {
    await expect(classifyToolFailure({ action, error: message })).resolves.toMatchObject({ category, recovery });
  });

  it('supports async extension classifiers', async () => {
    const unregister = registerToolFailureClassifier(async ({ error }) => (
      String(error).includes('vendor-specific')
        ? { category: 'conflict', recovery: 'revise_action', retryable: false, source: 'test-plugin', confidence: 1 }
        : null
    ), { prepend: true });

    await expect(classifyToolFailure({ action, error: 'vendor-specific failure' })).resolves.toMatchObject({
      category: 'conflict',
      source: 'test-plugin',
    });
    unregister();
  });

  it('prefers structured tool classifications', async () => {
    await expect(classifyToolFailure({
      action,
      error: {
        resultStatus: 'failed',
        failureCategory: 'session',
        failureRecovery: 'reconnect_then_retry',
        retryable: true,
      },
    })).resolves.toMatchObject({ category: 'session', source: 'structured', confidence: 1 });
  });
});
