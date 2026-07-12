import { useState } from 'react';
import { useT } from '../i18n/I18nProvider.jsx';
import { DialogShell } from './dialogs/DialogShell.jsx';

export function ContextMeter({ estimate }) {
  const t = useT();
  const [promptOpen, setPromptOpen] = useState(false);
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
        <>
          <button
            type="button"
            className="context-prompt-trigger"
            title={t('context.promptTitle')}
            onClick={() => setPromptOpen(true)}
          >
            <span>{t('context.promptToggle')}</span>
            <span title={promptPreview.modelId || ''}>{t('context.promptMeta', {
              model: promptPreview.modelId || '-',
              used: estimate.usedLabel || promptPreview.usedTokens || '-',
            })}</span>
          </button>
          {promptOpen && (
            <DialogShell
              title={t('context.promptTitle')}
              subtitle={t('context.promptMeta', {
                model: promptPreview.modelId || '-',
                used: estimate.usedLabel || promptPreview.usedTokens || '-',
              })}
              onClose={() => setPromptOpen(false)}
              dialogClassName="settings-dialog"
            >
              <div className="prompt-preview-content">
                <pre className="prompt-preview-text">{promptText}</pre>
              </div>
            </DialogShell>
          )}
        </>
      )}
    </div>
  );
}
