import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.jsx';

export function QuestionDialog({ question, submitting, onSubmit, onSkip }) {
  const t = useT();
  const [response, setResponse] = useState('');
  if (!question) return null;

  return (
    <div className="dialog-mask">
      <div className="dialog approval-dialog">
        <p className="approval-eyebrow">{t('question.eyebrow')}</p>
        <p className="dialog-title">{t('question.title', { step: question.step })}</p>
        <p className="dialog-desc">{question.message}</p>
        <textarea
          className="system-textarea"
          value={response}
          onChange={e => setResponse(e.target.value)}
          placeholder={t('question.placeholder')}
          rows={3}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(response); } }}
          autoFocus
        />
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onSkip} disabled={submitting}>
            {t('question.skip')}
          </button>
          <button
            className="dialog-btn confirm approval-confirm"
            onClick={() => onSubmit(response)}
            disabled={submitting}
          >
            {submitting ? t('common.submitting') : t('question.answer')}
          </button>
        </div>
      </div>
    </div>
  );
}
