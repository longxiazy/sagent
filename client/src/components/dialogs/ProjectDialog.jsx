import { useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';

// 新建/编辑项目对话框。project 传入则为编辑模式。
export function ProjectDialog({ project, onSubmit, onCancel }) {
  const t = useT();
  const [name, setName] = useState(project?.name || '');
  const [rootPath, setRootPath] = useState(project?.rootPath || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleCancel = () => {
    if (!submitting) onCancel();
  };

  const handleSubmit = async (event) => {
    event?.preventDefault?.();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit({ name: name.trim(), rootPath: rootPath.trim() });
    } catch (err) {
      setError(err.message || t('project.saveFailed'));
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-mask settings-mask" onClick={handleCancel}>
      <form className="dialog settings-dialog project-dialog" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <button
          type="button"
          className="settings-close-btn"
          onClick={handleCancel}
          disabled={submitting}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X size={18} strokeWidth={2} />
        </button>
        <p className="dialog-title">{project ? t('project.dialogEditTitle') : t('project.dialogNewTitle')}</p>

        <div className="settings-content project-dialog-content">
          <div className="settings-section">
            <p className="settings-section-title">{t('project.label')}</p>
            <div className="project-form-grid">
              <label className="settings-field project-field">
                <span>{t('project.nameLabel')}</span>
                <input
                  className="project-field-input"
                  type="text"
                  value={name}
                  placeholder={t('project.namePlaceholder')}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                />
              </label>

              <label className="settings-field project-field">
                <span>{t('project.rootLabel')}</span>
                <input
                  className="project-field-input"
                  type="text"
                  value={rootPath}
                  placeholder={t('project.rootPlaceholder')}
                  onChange={e => setRootPath(e.target.value)}
                />
              </label>
            </div>
            <p className="dialog-desc project-field-hint">{t('project.rootHint')}</p>

            {error ? <p className="settings-error">{error}</p> : null}
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-btn cancel" onClick={handleCancel} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="dialog-btn primary"
            disabled={submitting || !name.trim() || !rootPath.trim()}
          >
            {submitting ? t('common.submitting') : t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
