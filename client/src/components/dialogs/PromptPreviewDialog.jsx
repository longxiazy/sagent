import { useMemo, useState } from 'react';
import { useT } from '../../i18n/I18nProvider.jsx';
import { MarkdownBlock } from '../markdown/MarkdownBlock.jsx';
import { DialogShell } from './DialogShell.jsx';

function promptTextFromEstimate(estimate, truncatedMessage) {
  const preview = estimate?.promptPreview;
  if (!preview?.text) return '';
  return `${preview.text}${preview.truncated ? `\n\n${truncatedMessage}` : ''}`;
}

// value/onChange/editable are intentionally part of the API now so this viewer can
// become an editor later without changing its callers or duplicating another dialog.
export function PromptPreviewDialog({
  estimate,
  onClose,
  value,
  onChange,
  editable = false,
  initialMode = 'source',
}) {
  const t = useT();
  const preview = estimate?.promptPreview;
  const sourceText = useMemo(() => promptTextFromEstimate(
    estimate,
    t('context.promptTruncated', { chars: preview?.chars || 0 }),
  ), [estimate, preview?.chars, t]);
  const [mode, setMode] = useState(initialMode);
  const [draft, setDraft] = useState(value ?? sourceText);
  const displayedValue = editable ? (value ?? draft) : sourceText;

  if (!preview?.text) return null;

  const updateDraft = nextValue => {
    setDraft(nextValue);
    onChange?.(nextValue);
  };

  return (
    <DialogShell
      title={t('context.promptTitle')}
      subtitle={t('context.promptMeta', {
        model: preview.modelId || '-',
        used: estimate.usedLabel || preview.usedTokens || '-',
      })}
      onClose={onClose}
      dialogClassName="settings-dialog prompt-preview-dialog"
      headerActions={(
        <div className="settings-segment prompt-preview-mode" role="group" aria-label={t('context.promptViewMode')}>
          <button
            type="button"
            className={`settings-segment-btn${mode === 'source' ? ' active' : ''}`}
            onClick={() => setMode('source')}
          >
            {t('context.promptSource')}
          </button>
          <button
            type="button"
            className={`settings-segment-btn${mode === 'markdown' ? ' active' : ''}`}
            onClick={() => setMode('markdown')}
          >
            {t('context.promptMarkdown')}
          </button>
        </div>
      )}
    >
      <div className="prompt-preview-content">
        {mode === 'source' && editable ? (
          <textarea
            className="prompt-preview-editor"
            value={displayedValue}
            onChange={event => updateDraft(event.target.value)}
            spellCheck={false}
          />
        ) : mode === 'source' ? (
          <pre className="prompt-preview-text">{displayedValue}</pre>
        ) : (
          <MarkdownBlock content={displayedValue} className="prompt-preview-markdown" />
        )}
      </div>
    </DialogShell>
  );
}
