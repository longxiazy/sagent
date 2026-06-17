import { useMemo, useState } from 'react';
import { Brain, ChevronDown, Search, Trash2, X } from 'lucide-react';
import { getSessionTitle } from '../../hooks/useChatSessions.js';
import { usePersistentState, jsonStorage } from '../../hooks/usePersistentState.js';
import { calendarDaysAgo, formatRelativeTime, formatShortTime, formatFullTime } from '../../utils/format.js';
import { MemoryPanel } from './MemoryPanel.jsx';

const COLLAPSED_GROUPS_KEY = 'nvidia_chat_collapsed_groups';

// 按“最近活动时间”落入的分组（从新到旧）；match 接收 calendarDaysAgo 的自然日差。
const GROUP_DEFS = [
  { key: 'today', label: '今天', match: d => d === 0 },
  { key: 'yesterday', label: '昨天', match: d => d === 1 },
  { key: 'week', label: '近 7 天', match: d => d >= 2 && d < 7 },
  { key: 'month', label: '近 30 天', match: d => d >= 7 && d < 30 },
  { key: 'earlier', label: '更早', match: d => d >= 30 },
];

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

function formatSessionModels(session, modelList) {
  const models = uniqueModelIds(session.modelsUsed);
  const traceModels = models.length > 0 ? models : getTraceModels(session.agentTrace);
  const displayModels = traceModels.length > 0
    ? traceModels
    : uniqueModelIds(session.model ? [session.model] : []);

  if (displayModels.length === 0) {
    return '未知模型';
  }

  const labels = displayModels.map(model => modelList.find(item => item.id === model)?.label || model);
  const visible = labels.slice(0, 2).join(' + ');
  return labels.length > 2 ? `${visible} +${labels.length - 2}` : visible;
}

// 标题 + 全部消息内容做大小写不敏感匹配。
function sessionMatchesQuery(session, query) {
  if (getSessionTitle(session.messages).toLowerCase().includes(query)) {
    return true;
  }
  return session.messages.some(
    msg => typeof msg.content === 'string' && msg.content.toLowerCase().includes(query)
  );
}

// 过滤 + 按最近活动时间分组，组内按 updatedAt 倒序，空组剔除。
function buildGroups(sessions, query) {
  const q = query.trim().toLowerCase();
  const matched = q ? sessions.filter(session => sessionMatchesQuery(session, q)) : sessions;
  const sorted = [...matched].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return GROUP_DEFS
    .map(def => ({
      key: def.key,
      label: def.label,
      sessions: sorted.filter(session => def.match(calendarDaysAgo(session.updatedAt || session.createdAt || Date.now()))),
    }))
    .filter(group => group.sessions.length > 0);
}

function SessionCard({ session, active, modelLabel, locked, canDelete, onSelect, onDelete }) {
  const ts = session.updatedAt || session.createdAt;

  return (
    <div className={`session-card ${active ? 'active' : ''}`}>
      <button className="session-main" onClick={() => onSelect(session.id)} disabled={locked || active}>
        <span className="session-card-title">{getSessionTitle(session.messages)}</span>
        <span className="session-card-meta">{modelLabel} · {session.messages.length} 条</span>
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
          title="删除会话"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

export function SessionList({ sessions, activeSessionId, modelList, onDelete, onClearAll, onSelect, locked, showMemoryPanel, onToggleMemory }) {
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = usePersistentState(COLLAPSED_GROUPS_KEY, [], jsonStorage);

  const groups = useMemo(() => buildGroups(sessions, query), [sessions, query]);
  const searching = query.trim().length > 0;

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
        <h2 className="session-panel-title">会话</h2>
        <button className={`session-memory-btn ${showMemoryPanel ? 'active' : ''}`} onClick={onToggleMemory} title="查看记忆">
          <Brain size={13} />
        </button>
      </div>

      {showMemoryPanel ? (
        <MemoryPanel onClose={onToggleMemory} />
      ) : (
        <>
          <div className="session-search">
            <Search size={14} className="session-search-icon" />
            <input
              className="session-search-input"
              type="text"
              placeholder="搜索会话…"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {query && (
              <button className="session-search-clear" onClick={() => setQuery('')} title="清除">
                <X size={13} />
              </button>
            )}
          </div>

          <div className="session-list">
            {groups.length === 0 ? (
              <div className="session-empty">{searching ? '未找到匹配的会话' : '暂无会话'}</div>
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
                      <span className="session-group-label">{group.label}</span>
                      <span className="session-group-count">{group.sessions.length}</span>
                    </button>

                    {!collapsed && group.sessions.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        modelLabel={formatSessionModels(session, modelList)}
                        locked={locked}
                        canDelete={sessions.length > 1}
                        onSelect={onSelect}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                );
              })
            )}

            {sessions.length > 1 && (
              <button className="session-clear-all-btn" onClick={onClearAll} disabled={locked}>清空全部</button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
