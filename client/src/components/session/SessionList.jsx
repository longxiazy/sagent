import { useMemo, useState } from 'react';
import { BarChart3, Brain, ChevronDown, Search, Trash2, X } from 'lucide-react';
import { getSessionTitle } from '../../hooks/useChatSessions.js';
import { usePersistentState, jsonStorage } from '../../hooks/usePersistentState.js';
import { formatRelativeTime, formatShortTime, formatFullTime } from '../../utils/format.js';
import { buildGroups, lastActivityTs } from './session-grouping.js';
import { MemoryPanel } from './MemoryPanel.jsx';
import { ProjectSwitcher } from './ProjectSwitcher.jsx';
import { AgentStatsPanel } from './AgentStatsPanel.jsx';
import { useT } from '../../i18n/I18nProvider.jsx';

const COLLAPSED_GROUPS_KEY = 'nvidia_chat_collapsed_groups';

function uniqueModelIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()))];
}

function getTraceModels(trace) {
  if (!Array.isArray(trace)) {
    return [];
  }

  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const event = trace[i];
    const models = uniqueModelIds(event?.meta?.models_used);
    if (models.length > 0) {
      return models;
    }
  }

  const planned = trace.flatMap(event => {
    if (event?.type !== 'model_plan') return [];
    return event.model ? [event.model] : event.models;
  });
  return uniqueModelIds(planned);
}

function formatSessionModels(session, modelList, t) {
  const models = uniqueModelIds(session.modelsUsed);
  const traceModels = models.length > 0 ? models : getTraceModels(session.agentTrace);
  const displayModels = traceModels.length > 0
    ? traceModels
    : uniqueModelIds(session.model ? [session.model] : []);

  if (displayModels.length === 0) {
    return t('session.unknownModel');
  }

  const labels = displayModels.map(model => modelList.find(item => item.id === model)?.label || model);
  const visible = labels.slice(0, 2).join(' + ');
  return labels.length > 2 ? `${visible} +${labels.length - 2}` : visible;
}

function SessionCard({ session, active, modelLabel, locked, canDelete, onSelect, onDelete }) {
  const t = useT();
  const ts = lastActivityTs(session);

  return (
    <div className={`session-card ${active ? 'active' : ''}`}>
      <button className="session-main" onClick={() => onSelect(session.id)} disabled={locked || active}>
        <span className="session-card-title">{getSessionTitle(session.messages)}</span>
        <span className="session-card-meta">{modelLabel} · {t('session.messageCount', { n: session.messages.length })}</span>
        {ts ? (
          <span className="session-card-time" title={formatFullTime(ts)}>
            {formatRelativeTime(ts)} · {formatShortTime(ts)}
          </span>
        ) : null}
      </button>

      {canDelete && (
        <button
          className="session-delete-btn"
          onClick={() => onDelete(session.id)}
          disabled={locked}
          title={t('session.deleteTitle')}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

export function SessionList({
  sessions,
  activeSessionId,
  modelList,
  onDelete,
  onClearAll,
  onSelect,
  locked,
  showMemoryPanel,
  onToggleMemory,
  // project
  projects = [],
  activeProjectId = null,
  onActivateProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [showStatsPanel, setShowStatsPanel] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = usePersistentState(COLLAPSED_GROUPS_KEY, [], jsonStorage);

  // 只显示当前项目的会话；无项目态显示未归属项目的旧会话。
  const visibleSessions = useMemo(
    () => sessions.filter(s => (s.projectId ?? null) === (activeProjectId ?? null)),
    [sessions, activeProjectId]
  );

  const groups = useMemo(() => buildGroups(visibleSessions, query), [visibleSessions, query]);
  const searching = query.trim().length > 0;
  const statsPanelOpen = showStatsPanel && !showMemoryPanel;

  // 搜索时强制展开所有命中分组，避免折叠把结果藏起来。
  const isCollapsed = key => !searching && Array.isArray(collapsedGroups) && collapsedGroups.includes(key);
  const toggleGroup = key =>
    setCollapsedGroups(prev => {
      const list = Array.isArray(prev) ? prev : [];
      return list.includes(key) ? list.filter(k => k !== key) : [...list, key];
    });

  return (
    <aside className="session-panel">
      <div className="session-panel-header">
        <h2 className="session-panel-title">{t('session.title')}</h2>
        <div className="session-panel-actions">
          <button
            className={`session-icon-btn ${statsPanelOpen ? 'active' : ''}`}
            onClick={() => {
              if (!statsPanelOpen && showMemoryPanel) onToggleMemory();
              setShowStatsPanel(v => !v);
            }}
            title={t('session.viewAgentStats')}
          >
            <BarChart3 size={13} />
          </button>
          <button
            className={`session-icon-btn ${showMemoryPanel ? 'active' : ''}`}
            onClick={() => {
              setShowStatsPanel(false);
              onToggleMemory();
            }}
            title={t('session.viewMemory')}
          >
            <Brain size={13} />
          </button>
        </div>
      </div>

      {showMemoryPanel ? (
        <MemoryPanel onClose={onToggleMemory} activeProjectId={activeProjectId} modelList={modelList} />
      ) : statsPanelOpen ? (
        <AgentStatsPanel
          sessions={visibleSessions}
          modelList={modelList}
          onSelectSession={id => {
            onSelect(id);
            setShowStatsPanel(false);
          }}
          locked={locked}
        />
      ) : (
        <>
          <ProjectSwitcher
            projects={projects}
            activeProjectId={activeProjectId}
            onActivate={onActivateProject}
            onCreate={onCreateProject}
            onUpdate={onUpdateProject}
            onDelete={onDeleteProject}
            locked={locked}
          />

          <div className="session-search">
            <Search size={14} className="session-search-icon" />
            <input
              className="session-search-input"
              type="text"
              placeholder={t('session.searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {query && (
              <button className="session-search-clear" onClick={() => setQuery('')} title={t('session.clearSearch')}>
                <X size={13} />
              </button>
            )}
          </div>

          <div className="session-list">
            {groups.length === 0 ? (
              <div className="session-empty">{searching ? t('session.noMatch') : t('session.empty')}</div>
            ) : (
              groups.map(group => {
                const collapsed = isCollapsed(group.key);

                return (
                  <div key={group.key} className="session-group">
                    <button
                      className={`session-group-header ${collapsed ? 'collapsed' : ''}`}
                      onClick={() => toggleGroup(group.key)}
                    >
                      <ChevronDown size={14} className="session-group-chevron" />
                      <span className="session-group-label">{t(group.label)}</span>
                      <span className="session-group-count">{group.sessions.length}</span>
                    </button>

                    {!collapsed && group.sessions.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        modelLabel={formatSessionModels(session, modelList, t)}
                        locked={locked}
                        canDelete={visibleSessions.length > 1}
                        onSelect={onSelect}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                );
              })
            )}

            {visibleSessions.length > 1 && (
              <button className="session-clear-all-btn" onClick={onClearAll} disabled={locked}>{t('common.clearAll')}</button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
