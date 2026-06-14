import { Brain, Trash2 } from 'lucide-react';
import { getSessionTitle } from '../../hooks/useChatSessions.js';
import { MemoryPanel } from './MemoryPanel.jsx';

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

export function SessionList({ sessions, activeSessionId, modelList, onDelete, onClearAll, onSelect, locked, showMemoryPanel, onToggleMemory }) {
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
        <div className="session-list">
          {sessions.map(session => {
            const active = session.id === activeSessionId;
            const modelLabel = formatSessionModels(session, modelList);

            return (
              <div key={session.id} className={`session-card ${active ? 'active' : ''}`}>
                <button className="session-main" onClick={() => onSelect(session.id)} disabled={locked || active}>
                  <span className="session-card-title">{getSessionTitle(session.messages)}</span>
                  <span className="session-card-meta">{modelLabel} · {session.messages.length} 条</span>
                </button>

                {sessions.length > 1 && (
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
          })}

          {sessions.length > 1 && (
            <button className="session-clear-all-btn" onClick={onClearAll} disabled={locked}>清空全部</button>
          )}
        </div>
      )}
    </aside>
  );
}
