import { useMemo } from 'react';
import { renderMarkdown, inlineFormat } from '../../utils/markdown.js';
import { CodeBlock } from './CodeBlock.jsx';

export function MarkdownBlock({ content, className = '', showCursor = false }) {
  const blocks = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div className={className ? `md-body ${className}` : 'md-body'}>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={idx} language={block.lang}>{block.content}</CodeBlock>;
          case 'heading': {
            const HeadingTag = `h${block.level}`;
            return <HeadingTag key={idx} dangerouslySetInnerHTML={{ __html: inlineFormat(block.content) }} />;
          }
          case 'p':
            return <p key={idx} dangerouslySetInnerHTML={{ __html: inlineFormat(block.content) }} />;
          case 'ul':
            return <ul key={idx}>{block.items.map((item, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />)}</ul>;
          case 'ol':
            return <ol key={idx}>{block.items.map((item, j) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />)}</ol>;
          case 'table':
            return (
              <table key={idx}>
                <thead><tr>{block.headers.map((h, j) => <th key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(h) }} />)}</tr></thead>
                <tbody>{block.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k} dangerouslySetInnerHTML={{ __html: inlineFormat(cell) }} />)}</tr>)}</tbody>
              </table>
            );
          case 'hr':
            return <hr key={idx} />;
          default:
            return null;
        }
      })}
      {showCursor && <span className="cursor" />}
    </div>
  );
}
