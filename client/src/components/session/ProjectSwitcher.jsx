import { useState } from 'react';
import { ChevronDown, FolderGit2, Plus, Pencil, Trash2, Check } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';
import { ProjectDialog } from '../dialogs/ProjectDialog.jsx';

// 会话侧边栏顶部的项目切换器：下拉选择当前项目、新建/编辑/删除。
// activeProjectId = null 表示「无项目」全局态。
export function ProjectSwitcher({
  projects,
  activeProjectId,
  onActivate,
  onCreate,
  onUpdate,
  onDelete,
  locked,
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // { mode: 'new' } | { mode: 'edit', project }

  const activeProject = projects.find(p => p.projectId === activeProjectId) || null;
  const activeLabel = activeProject ? activeProject.name : t('project.noneShort');

  const handleSelect = (projectId) => {
    setOpen(false);
    if (projectId !== activeProjectId) onActivate(projectId);
  };

  const handleDelete = (e, project) => {
    e.stopPropagation();
    if (window.confirm(t('project.deleteConfirm', { name: project.name }))) {
      onDelete(project.projectId);
    }
  };

  const handleEdit = (e, project) => {
    e.stopPropagation();
    setOpen(false);
    setDialog({ mode: 'edit', project });
  };

  const submitDialog = async ({ name, rootPath }) => {
    if (dialog?.mode === 'edit') {
      await onUpdate(dialog.project.projectId, { name, rootPath });
    } else {
      const created = await onCreate({ name, rootPath });
      if (created?.projectId) onActivate(created.projectId);
    }
    setDialog(null);
  };

  return (
    <div className="project-switcher">
      <button
        className="project-switcher-trigger"
        onClick={() => setOpen(v => !v)}
        disabled={locked}
        title={t('project.switcherTitle')}
      >
        <FolderGit2 size={14} className="project-switcher-icon" />
        <span className="project-switcher-label">{activeLabel}</span>
        <ChevronDown size={14} className={`project-switcher-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <>
          <button className="project-switcher-backdrop" onClick={() => setOpen(false)} aria-hidden />
          <div className="project-switcher-menu">
            <button
              className={`project-switcher-item ${activeProjectId == null ? 'active' : ''}`}
              onClick={() => handleSelect(null)}
            >
              <span className="project-switcher-item-name">{t('project.none')}</span>
              {activeProjectId == null && <Check size={13} />}
            </button>

            {projects.length === 0 ? (
              <div className="project-switcher-empty">{t('project.empty')}</div>
            ) : (
              projects.map(project => (
                <button
                  key={project.projectId}
                  className={`project-switcher-item ${project.projectId === activeProjectId ? 'active' : ''}`}
                  onClick={() => handleSelect(project.projectId)}
                  title={project.rootPath}
                >
                  <span className="project-switcher-item-name">{project.name}</span>
                  <span className="project-switcher-item-actions">
                    <span className="project-switcher-mini" onClick={e => handleEdit(e, project)} title={t('project.edit')}>
                      <Pencil size={12} />
                    </span>
                    <span className="project-switcher-mini" onClick={e => handleDelete(e, project)} title={t('project.delete')}>
                      <Trash2 size={12} />
                    </span>
                    {project.projectId === activeProjectId && <Check size={13} />}
                  </span>
                </button>
              ))
            )}

            <button className="project-switcher-new" onClick={() => { setOpen(false); setDialog({ mode: 'new' }); }}>
              <Plus size={13} /> {t('project.new')}
            </button>
          </div>
        </>
      )}

      {dialog && (
        <ProjectDialog
          project={dialog.mode === 'edit' ? dialog.project : null}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
