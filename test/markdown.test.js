import { describe, expect, it } from 'vitest';
import { inlineFormat, renderMarkdown } from '../client/src/utils/markdown.js';

describe('final answer reference links', () => {
  it('renders an appended Markdown reference as a clickable external link', () => {
    const [list] = renderMarkdown('1. [https://official.example/a](https://official.example/a)');

    expect(list).toEqual({
      type: 'ol',
      items: ['[https://official.example/a](https://official.example/a)'],
    });
    expect(inlineFormat(list.items[0])).toBe(
      '<a href="https://official.example/a" target="_blank" rel="noopener noreferrer">https://official.example/a</a>',
    );
  });
});
