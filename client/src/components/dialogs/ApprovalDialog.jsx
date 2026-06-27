import { useT } from '../../i18n/I18nProvider.jsx';

export function ApprovalDialog({ approval, submitting, onApprove, onReject }) {
  const t = useT();
  if (!approval) {
    return null;
  }
  const actionJson = JSON.stringify(approval.action, null, 2);

  return (
    <div className="dialog-mask">
      <div className="dialog approval-dialog">
        <p className="approval-eyebrow">{t('approval.eyebrow')}</p>
        <p className="dialog-title">{t('approval.title', { step: approval.step })}</p>
        <p className="dialog-desc approval-message">{approval.message}</p>
        <pre className="agent-json approval-json">{actionJson}</pre>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onReject} disabled={submitting}>
            {t('approval.reject')}
          </button>
          <button className="dialog-btn confirm approval-confirm" onClick={onApprove} disabled={submitting}>
            {submitting ? t('common.submitting') : t('approval.approve')}
          </button>
        </div>
      </div>
    </div>
  );
}
