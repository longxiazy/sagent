import { MarkdownBlock } from './MarkdownBlock.jsx';
import { useT } from '../../i18n/I18nProvider.jsx';

export function ThinkBlock({ content, closed, showCursor }) {
  const t = useT();
  const preview = content.replace(/\s+/g, ' ').trim();

  return (
    <details className={`think-block ${closed ? 'ready' : 'streaming'}`} open={!closed || showCursor}>
      <summary className="think-summary">
        <span className="think-summary-badge">THINKING</span>
        <span className="think-summary-copy">
          <strong>{closed ? t('think.done') : t('think.thinking')}</strong>
          <span>{preview ? (preview.length > 72 ? `${preview.slice(0, 72)}…` : preview) : t('think.organizing')}</span>
        </span>
        <span className={`think-summary-meta ${closed ? 'ready' : 'running'}`}>{closed ? t('think.expand') : t('think.updating')}</span>
      </summary>

      <div className="think-body">
        <MarkdownBlock className="think-content" content={content || t('think.organizing')} showCursor={showCursor && !closed} />
      </div>
    </details>
  );
}
