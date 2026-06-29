import { useT } from '../i18n/I18nProvider.jsx';

export function ContextMeter({ estimate }) {
  const t = useT();
  if (!estimate) return null;

  const percent = Math.max(0, Math.min(100, estimate.percent || 0));
  const averagePercent = Math.max(0, Math.min(100, estimate.average?.percent || 0));
  const showAverage = estimate.modelCount > 1;
  const actual = estimate.source === 'actual_prompt_usage';
  const promptPreview = estimate.promptPreview;
  const promptText = promptPreview?.text
    ? `${promptPreview.text}${promptPreview.truncated ? `\n\n${t('context.promptTruncated', { chars: promptPreview.chars })}` : ''}`
    : '';

  return (
    <div className={`context-meter ${estimate.risk}${actual ? ' actual' : ''}`} aria-label={t(actual ? 'context.actualLabel' : 'context.label')}>
      <div className="context-meter-head">
        <span className="context-meter-title">{t(actual ? 'context.actualLabel' : 'context.label')}</span>
        <span className="context-meter-value">{t(actual ? 'context.actualSummary' : 'context.summary', {
          percent,
          used: estimate.usedLabel,
          limit: estimate.maxWindowLabel,
        })}</span>
      </div>
      <div className="context-meter-track" aria-hidden="true">
        <span className="context-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      {showAverage && (
        <div className="context-meter-sub">
          <span>{t(actual ? 'context.actualMax' : 'context.max', { percent })}</span>
          <span>{t(actual ? 'context.actualAvg' : 'context.avg', { percent: averagePercent })}</span>
        </div>
      )}
      {promptPreview?.text && (
        <details className="context-prompt-details">
          <summary className="context-prompt-summary">
            <span>{t('context.promptToggle')}</span>
            <span title={promptPreview.modelId || ''}>{t('context.promptMeta', {
              model: promptPreview.modelId || '-',
              used: estimate.usedLabel || promptPreview.usedTokens || '-',
            })}</span>
          </summary>
          <pre className="context-prompt-text">{promptText}</pre>
        </details>
      )}
    </div>
  );
}
