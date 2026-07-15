import { describe, expect, it } from 'vitest';
import { findContextWindow } from '../scripts/fetch-nvidia-model-catalog.mjs';

describe('NVIDIA catalog scraper', () => {
  it('parses bold bullet context length fields', () => {
    expect(findContextWindow('- **Context Length:** 4,096 tokens')).toBe(4_096);
  });

  it('keeps parsing the existing table format', () => {
    expect(findContextWindow('| **Context Length** | 128K tokens |')).toBe(128_000);
  });
});
