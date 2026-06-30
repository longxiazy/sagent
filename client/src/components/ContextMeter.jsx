import { useT } from '../i18n/I18nProvider.jsx';

export function ContextMeter({ estimate }) {
  const t = useT();
  if (!estimate) return null;

  const percent = Math.max(0, Math.min(100, estimate.percent || 0));
  const actual = estimate.source === 'actual_prompt_usage';
  const promptPreview = estimate.promptPreview;
  const promptText = promptPreview?.text
    ? `${promptPreview.text}${promptPreview.truncated ? `\n\n${t('context.promptTruncated', { chars: promptPreview.chars })}` : ''}`
    : '';
  const contextTitle = t(actual ? 'context.actualSummary' : 'context.summary', {
    percent,
    used: estimate.usedLabel,
    limit: estimate.maxWindowLabel,
  });

  return (
    <div className={`context-meter ${estimate.risk}${actual ? ' actual' : ''}`} aria-label={t(actual ? 'context.actualLabel' : 'context.label')}>
      <div className="context-meter-head" title={contextTitle}>
        <span className="context-meter-title">ctx</span>
        <span className="context-meter-value">{estimate.usedLabel}</span>
      </div>
      {promptPreview?.text && (
        <details className="context-prompt-details">
          <summary className="context-prompt-summary" title={t('context.promptTitle')}>
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
