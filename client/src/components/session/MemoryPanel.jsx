import { useEffect, useState } from 'react';
import { ChevronUp } from 'lucide-react';

export function MemoryPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [compacting, setCompacting] = useState(false);
  const [tab, setTab] = useState('conversation');

  useEffect(() => {
    setLoading(true);
    fetch('/api/agent/memory')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleCompact = async () => {
    setCompacting(true);
    try {
      const r = await fetch('/api/agent/compact', { method: 'POST' });
      const result = await r.json();
      if (result.ok) {
        const r2 = await fetch('/api/agent/memory');
        setData(await r2.json());
      }
    } finally {
      setCompacting(false);
    }
  };

  const handleClear = async (url) => {
    if (!confirm('确定要清空吗？此操作不可撤销。')) return;
    try {
      const r = await fetch(url, { method: 'DELETE' });
      const result = await r.json();
      if (result.ok) {
        const r2 = await fetch('/api/agent/memory');
        setData(await r2.json());
      }
    } catch { /* ignore */ }
  };

  const pk = data?.projectKnowledge || {};

  return (
    <div className="memory-panel">
      <div className="memory-panel-head">
        <div className="memory-panel-tabs">
          <button className={`memory-tab ${tab === 'conversation' ? 'active' : ''}`} onClick={() => setTab('conversation')}>
            对话 ({data?.conversationCount ?? 0})
          </button>
          <button className={`memory-tab ${tab === 'knowledge' ? 'active' : ''}`} onClick={() => setTab('knowledge')}>
            知识 ({(pk.structure?.length || 0) + Object.keys(pk.paths || {}).length + (pk.preferences?.length || 0) + (pk.learnings?.length || 0)})
          </button>
        </div>
        <button className="memory-panel-close" onClick={onClose}><ChevronUp size={14} /></button>
      </div>
      <div className="memory-panel-body">
        {loading ? (
          <div className="memory-loading">加载中…</div>
        ) : tab === 'conversation' ? (
          <>
            {data?.conversationSummary && (
              <div className="memory-section">
                <p className="memory-section-title">历史摘要{data.lastCompactedAt ? ` · 压缩于 ${new Date(data.lastCompactedAt).toLocaleString()}` : ''}</p>
                <p className="memory-summary-text">{data.conversationSummary}</p>
              </div>
            )}
            {(data?.conversation || []).length === 0 ? (
              <div className="memory-empty">暂无对话记录</div>
            ) : (
              <div className="memory-conversation-list">
                {[...(data.conversation || [])].reverse().map((entry, i) => (
                  <div key={i} className="memory-conv-item">
                    <div className="memory-conv-task">{entry.task}</div>
                    <div className="memory-conv-summary">{entry.summary}</div>
                    <div className="memory-conv-meta">
                      {entry.models?.length > 0 ? (
                        entry.models.map(m => <span key={m} className="memory-conv-model">{m.split('/').pop()}</span>)
                      ) : entry.model ? (
                        <span className="memory-conv-model">{entry.model.split('/').pop()}</span>
                      ) : null}
                      {entry.timestamp && <span className="memory-conv-time">{new Date(entry.timestamp).toLocaleString()}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {pk.structure?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">项目结构</p>
                {pk.structure.map((s, i) => <p key={i} className="memory-kv">{s}</p>)}
              </div>
            )}
            {Object.keys(pk.paths || {}).length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">常用路径</p>
                {Object.entries(pk.paths).map(([k, v]) => <p key={k} className="memory-kv"><span className="memory-k">{k}</span> {v}</p>)}
              </div>
            )}
            {pk.preferences?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">偏好</p>
                {pk.preferences.map((p, i) => <p key={i} className="memory-kv">{p}</p>)}
              </div>
            )}
            {pk.learnings?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">经验</p>
                {pk.learnings.map((l, i) => <p key={i} className="memory-kv">{l}</p>)}
              </div>
            )}
            {!pk.structure?.length && !Object.keys(pk.paths || {}).length && !pk.preferences?.length && !pk.learnings?.length && (
              <div className="memory-empty">暂无项目知识</div>
            )}
          </>
        )}
      </div>
      <div className="memory-panel-footer">
        <button className="memory-compact-btn" onClick={handleCompact} disabled={compacting}>
          {compacting ? '压缩中…' : '压缩历史'}
        </button>
        <div className="memory-clear-group">
          <button className="memory-clear-btn" onClick={() => handleClear('/api/agent/memory/knowledge')} title="清空项目知识，保留对话">
            清空知识
          </button>
          <button className="memory-clear-btn danger" onClick={() => handleClear('/api/agent/memory')} title="清空全部记忆">
            清空全部
          </button>
        </div>
      </div>
    </div>
  );
}
