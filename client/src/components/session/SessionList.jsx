import { Brain, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { getSessionTitle } from '../../hooks/useChatSessions.js';
import { MemoryPanel } from './MemoryPanel.jsx';

export function SessionList({ sessions, activeSessionId, modelList, onDelete, onClearAll, onSelect, showMemoryPanel, onToggleMemory, runningSessionIds, attentionSessionIds }) {
  const running = runningSessionIds || new Set();
  const attention = attentionSessionIds || new Set();
  const anyRunning = running.size > 0;
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
            const isRunning = running.has(session.id);
            const needsAttention = attention.has(session.id);

            return (
              <div key={session.id} className={`session-card ${active ? 'active' : ''} ${isRunning ? 'running' : ''}`}>
                {/* 多 run:切换会话不再被锁,允许在 agent 跑着时切去看/操作别的会话 */}
                <button className="session-main" onClick={() => onSelect(session.id)} disabled={active}>
                  <span className="session-card-title">
                    {isRunning && <Loader2 size={11} className="session-running-spinner" />}
                    {needsAttention && <AlertCircle size={11} className="session-attention-icon" />}
                    {getSessionTitle(session.messages)}
                  </span>
                  <span className="session-card-meta">{modelLabel} · {session.messages.length} 条</span>
                </button>

                {sessions.length > 1 && (
                  <button
                    className="session-delete-btn"
                    onClick={() => onDelete(session.id)}
                    disabled={isRunning}
                    title={isRunning ? '任务运行中,无法删除' : '删除会话'}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            );
          })}

          {sessions.length > 1 && (
            <button className="session-clear-all-btn" onClick={onClearAll} disabled={anyRunning}>清空全部</button>
          )}
        </div>
      )}
    </aside>
  );
}
