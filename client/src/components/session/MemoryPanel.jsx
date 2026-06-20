import { useEffect, useState } from 'react';
import { ChevronUp } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';
import { apiFetch } from '../../api/http.js';

export function MemoryPanel({ onClose, activeProjectId = null }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [compacting, setCompacting] = useState(false);
  const [tab, setTab] = useState('conversation');

  // 记忆按项目隔离：所有请求带上当前项目 id（无项目则查全局）。
  const qs = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : '';

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/agent/memory${qs}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [qs]);

  const handleCompact = async () => {
    setCompacting(true);
    try {
      const r = await apiFetch(`/api/agent/compact${qs}`, { method: 'POST' });
      const result = await r.json();
      if (result.ok) {
        const r2 = await apiFetch(`/api/agent/memory${qs}`);
        setData(await r2.json());
      }
    } finally {
      setCompacting(false);
    }
  };

  const handleClear = async (path) => {
    if (!confirm(t('memory.confirmClear'))) return;
    try {
      const r = await apiFetch(`${path}${qs}`, { method: 'DELETE' });
      const result = await r.json();
      if (result.ok) {
        const r2 = await apiFetch(`/api/agent/memory${qs}`);
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
            {t('memory.tabConversation', { n: data?.conversationCount ?? 0 })}
          </button>
          <button className={`memory-tab ${tab === 'knowledge' ? 'active' : ''}`} onClick={() => setTab('knowledge')}>
            {t('memory.tabKnowledge', { n: (pk.structure?.length || 0) + Object.keys(pk.paths || {}).length + (pk.preferences?.length || 0) + (pk.learnings?.length || 0) })}
          </button>
        </div>
        <button className="memory-panel-close" onClick={onClose}><ChevronUp size={14} /></button>
      </div>
      <div className="memory-panel-body">
        {loading ? (
          <div className="memory-loading">{t('common.loading')}</div>
        ) : tab === 'conversation' ? (
          <>
            {data?.conversationSummary && (
              <div className="memory-section">
                <p className="memory-section-title">{t('memory.historySummary')}{data.lastCompactedAt ? t('memory.compactedAt', { time: new Date(data.lastCompactedAt).toLocaleString() }) : ''}</p>
                <p className="memory-summary-text">{data.conversationSummary}</p>
              </div>
            )}
            {(data?.conversation || []).length === 0 ? (
              <div className="memory-empty">{t('memory.noConversation')}</div>
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
                <p className="memory-section-title">{t('memory.projectStructure')}</p>
                {pk.structure.map((s, i) => <p key={i} className="memory-kv">{s}</p>)}
              </div>
            )}
            {Object.keys(pk.paths || {}).length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">{t('memory.commonPaths')}</p>
                {Object.entries(pk.paths).map(([k, v]) => <p key={k} className="memory-kv"><span className="memory-k">{k}</span> {v}</p>)}
              </div>
            )}
            {pk.preferences?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">{t('memory.preferences')}</p>
                {pk.preferences.map((p, i) => <p key={i} className="memory-kv">{p}</p>)}
              </div>
            )}
            {pk.learnings?.length > 0 && (
              <div className="memory-section">
                <p className="memory-section-title">{t('memory.learnings')}</p>
                {pk.learnings.map((l, i) => <p key={i} className="memory-kv">{l}</p>)}
              </div>
            )}
            {!pk.structure?.length && !Object.keys(pk.paths || {}).length && !pk.preferences?.length && !pk.learnings?.length && (
              <div className="memory-empty">{t('memory.noKnowledge')}</div>
            )}
          </>
        )}
      </div>
      <div className="memory-panel-footer">
        <button className="memory-compact-btn" onClick={handleCompact} disabled={compacting}>
          {compacting ? t('memory.compacting') : t('memory.compactHistory')}
        </button>
        <div className="memory-clear-group">
          <button className="memory-clear-btn" onClick={() => handleClear('/api/agent/memory/knowledge')} title={t('memory.clearKnowledgeTitle')}>
            {t('memory.clearKnowledge')}
          </button>
          <button className="memory-clear-btn danger" onClick={() => handleClear('/api/agent/memory')} title={t('memory.clearAllTitle')}>
            {t('common.clearAll')}
          </button>
        </div>
      </div>
    </div>
  );
}
