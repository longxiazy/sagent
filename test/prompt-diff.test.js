import { describe, it, expect } from 'vitest';
import { buildPromptDiff } from '../client/src/utils/prompt-diff.js';

describe('buildPromptDiff', () => {
  it('marks no previous request as a single equal block', () => {
    const { hasPrevious, blocks } = buildPromptDiff('', 'line a\nline b');
    expect(hasPrevious).toBe(false);
    expect(blocks).toEqual([{ type: 'equal', text: 'line a\nline b' }]);
  });

  it('returns only equal blocks when text is identical', () => {
    const text = 'a\nb\nc';
    const { hasPrevious, blocks } = buildPromptDiff(text, text);
    expect(hasPrevious).toBe(true);
    expect(blocks.every(b => b.type === 'equal')).toBe(true);
    expect(blocks.map(b => b.text).join('\n')).toBe(text);
  });

  it('produces word-level add/del segments inside a changed line', () => {
    const previous = 'step 1 observation foo';
    const current = 'step 2 observation foo';
    const { blocks } = buildPromptDiff(previous, current);
    const change = blocks.find(b => b.type === 'change');
    expect(change).toBeTruthy();
    // 未改动词保持 same，数字 1→2 分别产出 del / add。
    expect(change.segments.some(s => s.op === 'add' && s.value.includes('2'))).toBe(true);
    expect(change.segments.some(s => s.op === 'del' && s.value.includes('1'))).toBe(true);
    expect(change.segments.some(s => s.op === 'same' && s.value.includes('observation'))).toBe(true);
  });

  it('keeps a large unchanged region as one equal block for folding', () => {
    const shared = Array.from({ length: 20 }, (_, i) => `const line ${i}`).join('\n');
    const previous = `${shared}\nstep 1`;
    const current = `${shared}\nstep 2`;
    const { blocks } = buildPromptDiff(previous, current);
    const equalBlock = blocks.find(b => b.type === 'equal' && b.text.split('\n').length >= 20);
    expect(equalBlock).toBeTruthy();
    expect(blocks.some(b => b.type === 'change')).toBe(true);
  });

  it('degrades gracefully when the diff size exceeds maxProduct', () => {
    const previous = Array.from({ length: 40 }, (_, i) => `p${i}`).join('\n');
    const current = Array.from({ length: 40 }, (_, i) => `c${i}`).join('\n');
    const { blocks } = buildPromptDiff(previous, current, { maxProduct: 4 });
    const change = blocks.find(b => b.type === 'change');
    expect(change).toBeTruthy();
    // 退化路径：全删 + 全增，仍能给出 del 与 add。
    expect(change.segments.some(s => s.op === 'del')).toBe(true);
    expect(change.segments.some(s => s.op === 'add')).toBe(true);
  });
});
