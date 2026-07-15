import { describe, expect, it } from 'vitest';
import { formatTokenLimit } from '../client/src/utils/token-limit.js';

describe('model selector token formatting', () => {
  it('formats decimal and binary-aligned context sizes using familiar labels', () => {
    expect(formatTokenLimit(4_096)).toBe('4K');
    expect(formatTokenLimit(128_000)).toBe('128K');
    expect(formatTokenLimit(131_072)).toBe('128K');
    expect(formatTokenLimit(204_800)).toBe('200K');
    expect(formatTokenLimit(1_048_576)).toBe('1M');
  });

  it('returns null for missing or invalid limits', () => {
    expect(formatTokenLimit(null)).toBeNull();
    expect(formatTokenLimit(0)).toBeNull();
  });
});
