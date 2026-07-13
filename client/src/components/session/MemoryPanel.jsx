import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';
import { apiFetch } from '../../api/http.js';
import { fetchCodegraph, reindexCodegraph } from '../../api/codegraph.js';
import { SingleModelSelector } from '../ModelSelector.jsx';

export function MemoryPanel({ onClose, activeProjectId = null, modelList = [] }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('knowledge');

  // 记忆按项目隔离：所有请求带上当前项目 id（无项目则查全局）。
  const qs = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : '';

  useEffect(() => {
    apiFetch(`/api/agent/memory${qs}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [qs]);

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
          <button className={`memory-tab ${tab === 'knowledge' ? 'active' : ''}`} onClick={() => setTab('knowledge')}>
            {t('memory.tabKnowledge', { n: (pk.structure?.length || 0) + Object.keys(pk.paths || {}).length + (pk.preferences?.length || 0) + (pk.learnings?.length || 0) })}
          </button>
          <button className={`memory-tab ${tab === 'codegraph' ? 'active' : ''}`} onClick={() => setTab('codegraph')}>
            {t('codegraph.tab')}
          </button>
        </div>
        <button className="memory-panel-close" onClick={onClose}><ChevronUp size={14} /></button>
      </div>
      <div className="memory-panel-body">
        {tab === 'codegraph' ? (
          <CodeGraphTab activeProjectId={activeProjectId} modelList={modelList} />
        ) : loading ? (
          <div className="memory-loading">{t('common.loading')}</div>
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
      {tab === 'knowledge' && (
        <div className="memory-panel-footer">
          <div className="memory-clear-group">
            <button className="memory-clear-btn danger" onClick={() => handleClear('/api/agent/memory')} title={t('memory.clearKnowledgeTitle')}>
              {t('memory.clearKnowledge')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Code Graph 标签页：状态卡 + 模型下拉 + 重新索引(后台任务,轮询进度) + 本地搜索 + 模块依赖列表。
function CodeGraphTab({ activeProjectId, modelList }) {
  const t = useT();
  const [cg, setCg] = useState(null);          // { graph, job }
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState('');
  const [reindexing, setReindexing] = useState(false);
  const [search, setSearch] = useState('');

  // 模型配置变更时只清理失效选择，不自动挑默认模型。
  useEffect(() => {
    if (model && !modelList.some(item => item.id === model)) {
      setModel('');
    }
  }, [modelList, model]);

  // 切到该 tab / 切项目时拉一次。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCodegraph(activeProjectId)
      .then(d => { if (!cancelled) setCg(d); })
      .catch(() => { if (!cancelled) setCg(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  // 索引进行中时轮询进度,直到 done/error。
  useEffect(() => {
    if (cg?.job?.status !== 'indexing') return undefined;
    const timer = setTimeout(() => {
      fetchCodegraph(activeProjectId).then(setCg).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [cg, activeProjectId]);

  const handleReindex = async () => {
    if (!model) return;
    setReindexing(true);
    try {
      const d = await reindexCodegraph(activeProjectId, model);
      setCg(prev => ({ graph: prev?.graph ?? null, job: d.job }));
    } catch (err) {
      alert(t('codegraph.error', { error: err.message || String(err) }));
    } finally {
      setReindexing(false);
    }
  };

  const graph = cg?.graph || null;
  const job = cg?.job || null;
  const indexing = job?.status === 'indexing';

  // 本地过滤(图谱已在前端,无需再请求后端)。
  const filtered = useMemo(() => {
    const all = graph?.modules || [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(m =>
      m.path.toLowerCase().includes(q)
      || (m.description || '').toLowerCase().includes(q)
      || (m.group || '').toLowerCase().includes(q)
      || (m.exports || []).some(e => e.toLowerCase().includes(q))
    );
  }, [graph, search]);

  // 按 group 分组,组内按路径排序,组按大小降序。
  const grouped = useMemo(() => {
    const map = new Map();
    for (const m of filtered) {
      const g = m.group || 'other';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(m);
    }
    return [...map.entries()]
      .map(([g, mods]) => [g, mods.sort((a, b) => a.path.localeCompare(b.path))])
      .sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  return (
    <div className="codegraph-tab">
      {/* 状态卡 + 操作 */}
      <div className="codegraph-controls">
        {graph ? (
          <div className="codegraph-stats">
            <span className="codegraph-stats-main">{t('codegraph.stats', {
              files: graph.stats?.totalFiles ?? 0,
              modules: graph.stats?.totalModules ?? 0,
              coverage: graph.stats?.coverage ?? '0%',
            })}</span>
            {graph.lastIndexed && (
              <span className="codegraph-stats-sub">
                {t('codegraph.lastIndexed', { time: new Date(graph.lastIndexed).toLocaleString() })}
                {graph.model ? ` · ${graph.model.split('/').pop()}` : ''}
              </span>
            )}
          </div>
        ) : (
          <div className="codegraph-stats codegraph-stats-empty">{t('codegraph.notIndexed')}</div>
        )}

        <div className="codegraph-actions">
          <SingleModelSelector
            className="codegraph-model-picker"
            availableModels={modelList}
            value={model}
            onChange={setModel}
            disabled={indexing || reindexing || modelList.length === 0}
            title={t('codegraph.modelTitle')}
            placeholder={modelList.length === 0 ? t('codegraph.noModel') : t('modelSelector.selectModel')}
            dialogTitle={t('codegraph.modelTitle')}
          />
          <button
            className="codegraph-reindex-btn"
            onClick={handleReindex}
            disabled={indexing || reindexing || !model}
          >
            <RefreshCw size={12} className={indexing ? 'spinning' : ''} />
            {indexing ? t('codegraph.indexing') : t('codegraph.reindex')}
          </button>
        </div>
      </div>

      {/* 进度 / 错误 */}
      {indexing && (
        <div className="codegraph-progress">
          {job.phase === 'scanning'
            ? t('codegraph.scanning')
            : t('codegraph.describing', { done: job.done ?? 0, total: job.total ?? 0 })}
        </div>
      )}
      {job?.status === 'error' && (
        <div className="codegraph-progress codegraph-progress-error">{t('codegraph.error', { error: job.error || '' })}</div>
      )}

      {/* 主体 */}
      {loading ? (
        <div className="memory-loading">{t('common.loading')}</div>
      ) : !graph ? (
        <div className="memory-empty">{t('codegraph.empty')}</div>
      ) : (
        <>
          {graph.summary && <p className="codegraph-summary">{graph.summary}</p>}
          <div className="codegraph-search">
            <input
              type="text"
              className="codegraph-search-input"
              placeholder={t('codegraph.searchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {filtered.length === 0 ? (
            <div className="memory-empty">{t('codegraph.noMatch')}</div>
          ) : (
            <div className="codegraph-modules">
              {grouped.map(([group, mods]) => (
                <div key={group} className="codegraph-group">
                  <p className="codegraph-group-title">{group} <span className="codegraph-group-count">{mods.length}</span></p>
                  {mods.map(m => (
                    <div key={m.path} className="codegraph-module">
                      <div className="codegraph-module-path">{m.path}</div>
                      {m.description && <div className="codegraph-module-desc">{m.description}</div>}
                      {m.dependsOn?.length > 0 && (
                        <div className="codegraph-module-deps" title={m.dependsOn.join('\n')}>
                          {t('codegraph.dependsOn', { n: m.dependsOn.length })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
