import { describe, expect, it } from 'vitest';
import { isFailureResult, splitFailureHighlights } from '../client/src/components/agent/result-status.js';

describe('agent result status helpers', () => {
  it('uses structured result status before legacy keywords', () => {
    expect(isFailureResult('未找到明显问题', 'success')).toBe(false);
    expect(isFailureResult('未找到明显问题', 'rejected')).toBe(false);
    expect(isFailureResult('command exited without keywords', 'failed')).toBe(true);
  });

  it('does not highlight legacy failure keywords for structured non-failures', () => {
    expect(splitFailureHighlights('未找到明显问题', 'success')).toEqual([
      { text: '未找到明显问题', hit: false },
    ]);
    expect(splitFailureHighlights('未找到明显问题', 'rejected')).toEqual([
      { text: '未找到明显问题', hit: false },
    ]);
  });
});
