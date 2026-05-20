import { MarkdownBlock } from './MarkdownBlock.jsx';

export function ThinkBlock({ content, closed, showCursor }) {
  const preview = content.replace(/\s+/g, ' ').trim();

  return (
    <details className={`think-block ${closed ? 'ready' : 'streaming'}`} open={!closed || showCursor}>
      <summary className="think-summary">
        <span className="think-summary-badge">THINK</span>
        <span className="think-summary-copy">
          <strong>{closed ? '思考过程' : '思考中'}</strong>
          <span>{preview ? (preview.length > 72 ? `${preview.slice(0, 72)}…` : preview) : '正在组织思路…'}</span>
        </span>
        <span className={`think-summary-meta ${closed ? 'ready' : 'running'}`}>{closed ? '展开' : '更新中'}</span>
      </summary>

      <div className="think-body">
        <MarkdownBlock className="think-content" content={content || '正在组织思路…'} showCursor={showCursor && !closed} />
      </div>
    </details>
  );
}
