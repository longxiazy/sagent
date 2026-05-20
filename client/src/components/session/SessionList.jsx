import { Brain, Trash2 } from 'lucide-react';
import { getSessionTitle } from '../../hooks/useChatSessions.js';
import { MemoryPanel } from './MemoryPanel.jsx';

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
            const modelLabel = modelList.find(item => item.id === session.model)?.label || session.model;

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
