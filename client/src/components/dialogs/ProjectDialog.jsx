import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider.jsx';

// 新建/编辑项目对话框。project 传入则为编辑模式。
export function ProjectDialog({ project, onSubmit, onCancel }) {
  const t = useT();
  const [name, setName] = useState(project?.name || '');
  const [rootPath, setRootPath] = useState(project?.rootPath || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
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
    <div className="dialog-mask">
      <div className="dialog">
        <p className="dialog-title">{project ? t('project.dialogEditTitle') : t('project.dialogNewTitle')}</p>

        <label className="project-field-label">{t('project.nameLabel')}</label>
        <input
          className="project-field-input"
          type="text"
          value={name}
          placeholder={t('project.namePlaceholder')}
          onChange={e => setName(e.target.value)}
          autoFocus
        />

        <label className="project-field-label">{t('project.rootLabel')}</label>
        <input
          className="project-field-input"
          type="text"
          value={rootPath}
          placeholder={t('project.rootPlaceholder')}
          onChange={e => setRootPath(e.target.value)}
        />
        <p className="project-field-hint">{t('project.rootHint')}</p>

        {error ? <p className="project-field-error">{error}</p> : null}

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            className="dialog-btn confirm"
            onClick={handleSubmit}
            disabled={submitting || !name.trim() || !rootPath.trim()}
          >
            {submitting ? t('common.submitting') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
