import { useEffect, useState } from 'react';
import { ChevronUp, Trash2, X } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';
import {
  listScreenshots,
  deleteScreenshot,
  deleteScreenshotRun,
  clearScreenshots,
  runScreenshotCleanup,
} from '../../api/screenshots.js';
import { saveTools } from '../../api/config.js';

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ScreenshotPanel({ onClose }) {
  const t = useT();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState(null);
  const [busy, setBusy] = useState(false);

  // 保留策略表单(截图是全局配置,写回不带 projectId)。redaction 需在保存时原样带回,避免被覆盖。
  const [enabled, setEnabled] = useState(false);
  const [maxAgeDays, setMaxAgeDays] = useState('');
  const [maxTotalMB, setMaxTotalMB] = useState('');
  const [redaction, setRedaction] = useState(undefined);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policySaved, setPolicySaved] = useState(false);

  const applyConfig = (payload) => {
    const sc = payload?.screenshots || {};
    const r = sc.retention || {};
    setEnabled(Boolean(r.enabled));
    setMaxAgeDays(r.maxAgeDays != null ? String(r.maxAgeDays) : '');
    setMaxTotalMB(r.maxTotalMB != null ? String(r.maxTotalMB) : '');
    setRedaction(sc.redaction);
  };

  const load = async () => {
    try {
      const d = await listScreenshots();
      setData(d);
      applyConfig(d);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    try {
      setData(await listScreenshots());
    } catch { /* ignore */ }
  };

  const handleDeleteFile = async (runId, name) => {
    await deleteScreenshot(runId, name);
    await refresh();
  };

  const handleDeleteRun = async (runId) => {
    if (!confirm(t('screenshots.confirmDeleteRun'))) return;
    await deleteScreenshotRun(runId);
    await refresh();
  };

  const handleClearAll = async () => {
    if (!confirm(t('screenshots.confirmClearAll'))) return;
    setBusy(true);
    await clearScreenshots();
    await refresh();
    setBusy(false);
  };

  const handleCleanup = async () => {
    setBusy(true);
    try {
      const d = await runScreenshotCleanup();
      setData(d);
      applyConfig(d);
    } catch { /* ignore */ }
    setBusy(false);
  };

  const handleSavePolicy = async () => {
    setSavingPolicy(true);
    setPolicySaved(false);
    const retention = { enabled };
    const age = Number(maxAgeDays);
    if (maxAgeDays !== '' && Number.isFinite(age) && age >= 0) retention.maxAgeDays = age;
    const mb = Number(maxTotalMB);
    if (maxTotalMB !== '' && Number.isFinite(mb) && mb >= 0) retention.maxTotalMB = mb;
    const screenshots = { retention };
    if (redaction) screenshots.redaction = redaction;
    try {
      await saveTools({ screenshots });
      setPolicySaved(true);
      setTimeout(() => setPolicySaved(false), 2000);
    } catch { /* ignore */ }
    setSavingPolicy(false);
  };

  const total = data?.total || { count: 0, bytes: 0 };
  const groups = data?.groups || [];

  return (
    <div className="memory-panel screenshot-panel">
      <div className="memory-panel-head">
        <span className="memory-panel-title">
          {t('screenshots.title', { n: total.count })} · {formatSize(total.bytes)}
        </span>
        <button className="memory-panel-close" onClick={onClose}><ChevronUp size={14} /></button>
      </div>

      <div className="memory-panel-body">
        <div className="screenshot-retention">
          <label className="screenshot-retention-toggle">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            {t('screenshots.retentionEnabled')}
          </label>
          <div className="screenshot-retention-fields">
            <label className="screenshot-retention-field">
              <span>{t('screenshots.maxAgeDays')}</span>
              <input type="number" min="0" value={maxAgeDays} onChange={e => setMaxAgeDays(e.target.value)} placeholder="0" />
            </label>
            <label className="screenshot-retention-field">
              <span>{t('screenshots.maxTotalMB')}</span>
              <input type="number" min="0" value={maxTotalMB} onChange={e => setMaxTotalMB(e.target.value)} placeholder="0" />
            </label>
          </div>
          <div className="screenshot-retention-actions">
            <button className="memory-clear-btn" onClick={handleSavePolicy} disabled={savingPolicy}>
              {t('common.save')}
            </button>
            {policySaved && <span className="screenshot-saved">{t('common.saved')}</span>}
          </div>
          <p className="screenshot-retention-hint">{t('screenshots.retentionHint')}</p>
        </div>

        {loading ? (
          <div className="memory-loading">{t('common.loading')}</div>
        ) : groups.length === 0 ? (
          <div className="memory-empty">{t('screenshots.empty')}</div>
        ) : (
          groups.map(group => (
            <div key={group.runId} className="screenshot-group">
              <div className="screenshot-group-head">
                <span className="screenshot-group-run" title={group.runId}>{group.runId}</span>
                <span className="screenshot-group-meta">{group.count} · {formatSize(group.bytes)}</span>
                <button className="screenshot-group-del" onClick={() => handleDeleteRun(group.runId)} title={t('screenshots.deleteRun')}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="screenshot-grid">
                {group.files.map(file => (
                  <div key={file.name} className={`screenshot-cell kind-${file.kind}`}>
                    <img src={file.url} alt={file.name} loading="lazy" onClick={() => setLightbox(file.url)} />
                    <button className="screenshot-cell-del" onClick={() => handleDeleteFile(group.runId, file.name)} title={t('screenshots.deleteImage')}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="memory-panel-footer">
        <button className="memory-clear-btn" onClick={handleCleanup} disabled={busy} title={t('screenshots.cleanupNowTitle')}>
          {t('screenshots.cleanupNow')}
        </button>
        <div className="memory-clear-group">
          <button className="memory-clear-btn danger" onClick={handleClearAll} disabled={busy || total.count === 0}>
            {t('screenshots.clearAll')}
          </button>
        </div>
      </div>

      {lightbox && (
        <div className="screenshot-lightbox" onClick={() => setLightbox(null)}>
          <img className="screenshot-lightbox-img" src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
