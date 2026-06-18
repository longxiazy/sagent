import { useT } from '../../i18n/I18nProvider.jsx';

export function ResetDialog({ onConfirm, onCancel }) {
  const t = useT();
  return (
    <div className="dialog-mask">
      <div className="dialog">
        <p className="dialog-title">{t('reset.title')}</p>
        <p className="dialog-desc">{t('reset.desc')}</p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="dialog-btn confirm" onClick={onConfirm}>
            {t('reset.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
