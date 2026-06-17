import { useEffect, useState } from 'react';
import { fetchConfig, saveConfig, resetConfig } from '../../api/config.js';

// Agent 行为参数（可写，热生效）。单位与 .env 一致，换算放后端消费点。
const NUM_FIELDS = [
  { key: 'maxSteps', label: '单次任务最大步数' },
  { key: 'modelTimeoutSec', label: '单模型超时（秒）' },
  { key: 'staggerDelaySec', label: '竞速批次间隔（秒）' },
  { key: 'batchSize', label: '每批启动模型数' },
  { key: 'maxHistorySteps', label: '最大历史步数' },
  { key: 'maxResultChars', label: '每步结果最大字符数' },
  { key: 'maxParallelResultChars', label: '并行抓取字符上限' },
  { key: 'memoryMaxEntries', label: '记忆压缩阈值' },
];

// 设置面板：Agent 行为参数可写（保存后下次任务即生效），API Key 只读展示。
export function SettingsDialog({ onClose }) {
  const [agent, setAgent] = useState(null);
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then(data => {
        if (!alive) return;
        setAgent(data.agent);
        setKeys(data.keys || []);
      })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const setField = (key, value) => {
    setAgent(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const data = await saveConfig(agent);
      setAgent(data.agent);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError('');
    try {
      const data = await resetConfig();
      setAgent(data.agent);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={e => e.stopPropagation()}>
        <p className="dialog-title">设置</p>

        {loading ? (
          <p className="dialog-desc">加载中…</p>
        ) : !agent ? (
          <p className="settings-error">{error || '加载失败'}</p>
        ) : (
          <>
            <div className="settings-section">
              <p className="settings-section-title">Agent 行为参数</p>
              <p className="dialog-desc">保存后下次任务即生效，无需重启后端。</p>
              <div className="settings-grid">
                {NUM_FIELDS.map(f => (
                  <label key={f.key} className="settings-field">
                    <span>{f.label}</span>
                    <input
                      type="number"
                      value={agent[f.key]}
                      onChange={e => setField(f.key, e.target.value === '' ? '' : Number(e.target.value))}
                    />
                  </label>
                ))}
                <label className="settings-field settings-field-switch">
                  <span>观测 macOS 桌面</span>
                  <input
                    type="checkbox"
                    checked={!!agent.observeDesktop}
                    onChange={e => setField('observeDesktop', e.target.checked)}
                  />
                </label>
              </div>
            </div>

            <div className="settings-section">
              <p className="settings-section-title">API Key（只读）</p>
              <p className="dialog-desc">Key 在 .env 配置，修改后需重启后端。</p>
              <div className="settings-keys">
                {keys.map(k => (
                  <div key={k.envVar} className="settings-key-row">
                    <span className="settings-key-provider">{k.provider}</span>
                    <span className={`settings-key-status ${k.configured ? 'on' : 'off'}`}>
                      {k.configured ? k.masked : '未配置'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {error && <p className="settings-error">{error}</p>}
            {saved && !error && <p className="settings-ok">已保存</p>}
          </>
        )}

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onClose} disabled={saving}>关闭</button>
          <button className="dialog-btn" onClick={handleReset} disabled={loading || saving || !agent}>恢复默认</button>
          <button className="dialog-btn primary" onClick={handleSave} disabled={loading || saving || !agent}>保存</button>
        </div>
      </div>
    </div>
  );
}
