import { useEffect, useState } from 'react';
import { fetchConfig, saveConfig, resetConfig } from '../../api/config.js';
import { useTheme } from '../../theme/ThemeProvider.jsx';
import { useI18n, useT } from '../../i18n/I18nProvider.jsx';

// Agent 行为参数（可写，热生效）。单位与 .env 一致，换算放后端消费点。
// label 改为 i18n key，渲染时经 t() 取文案。
const NUM_FIELDS = [
  { key: 'maxSteps', labelKey: 'settings.maxSteps' },
  { key: 'modelTimeoutSec', labelKey: 'settings.modelTimeoutSec' },
  { key: 'staggerDelaySec', labelKey: 'settings.staggerDelaySec' },
  { key: 'batchSize', labelKey: 'settings.batchSize' },
  { key: 'maxHistorySteps', labelKey: 'settings.maxHistorySteps' },
  { key: 'maxResultChars', labelKey: 'settings.maxResultChars' },
  { key: 'maxParallelResultChars', labelKey: 'settings.maxParallelResultChars' },
  { key: 'memoryMaxEntries', labelKey: 'settings.memoryMaxEntries' },
];

const THEME_OPTIONS = [
  { value: 'light', labelKey: 'appearance.theme.light' },
  { value: 'dark', labelKey: 'appearance.theme.dark' },
  { value: 'system', labelKey: 'appearance.theme.system' },
];

// 设置面板：外观（主题/语言，前台即时生效）、Agent 行为参数（保存后下次任务生效）、API Key 只读展示。
export function SettingsDialog({ onClose }) {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useI18n();
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
        <p className="dialog-title">{t('settings.title')}</p>

        <div className="settings-section">
          <p className="settings-section-title">{t('appearance.title')}</p>
          <div className="settings-field settings-field-switch">
            <span>{t('appearance.theme')}</span>
            <div className="settings-segment">
              {THEME_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`settings-segment-btn${theme === opt.value ? ' active' : ''}`}
                  onClick={() => setTheme(opt.value)}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-field settings-field-switch">
            <span>{t('appearance.language')}</span>
            <div className="settings-segment">
              <button
                className={`settings-segment-btn${locale === 'zh' ? ' active' : ''}`}
                onClick={() => setLocale('zh')}
              >中文</button>
              <button
                className={`settings-segment-btn${locale === 'en' ? ' active' : ''}`}
                onClick={() => setLocale('en')}
              >English</button>
            </div>
          </div>
        </div>

        {loading ? (
          <p className="dialog-desc">{t('common.loading')}</p>
        ) : !agent ? (
          <p className="settings-error">{error || t('common.loadFailed')}</p>
        ) : (
          <>
            <div className="settings-section">
              <p className="settings-section-title">{t('settings.agentParams')}</p>
              <p className="dialog-desc">{t('settings.agentParamsDesc')}</p>
              <div className="settings-grid">
                {NUM_FIELDS.map(f => (
                  <label key={f.key} className="settings-field">
                    <span>{t(f.labelKey)}</span>
                    <input
                      type="number"
                      value={agent[f.key]}
                      onChange={e => setField(f.key, e.target.value === '' ? '' : Number(e.target.value))}
                    />
                  </label>
                ))}
                <label className="settings-field settings-field-switch">
                  <span>{t('settings.observeDesktop')}</span>
                  <input
                    type="checkbox"
                    checked={!!agent.observeDesktop}
                    onChange={e => setField('observeDesktop', e.target.checked)}
                  />
                </label>
              </div>
            </div>

            <div className="settings-section">
              <p className="settings-section-title">{t('settings.apiKeys')}</p>
              <p className="dialog-desc">{t('settings.apiKeysDesc')}</p>
              <div className="settings-keys">
                {keys.map(k => (
                  <div key={k.envVar} className="settings-key-row">
                    <span className="settings-key-provider">{k.provider}</span>
                    <span className={`settings-key-status ${k.configured ? 'on' : 'off'}`}>
                      {k.configured ? k.masked : t('settings.keyNotConfigured')}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {error && <p className="settings-error">{error}</p>}
            {saved && !error && <p className="settings-ok">{t('common.saved')}</p>}
          </>
        )}

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onClose} disabled={saving}>{t('common.close')}</button>
          <button className="dialog-btn" onClick={handleReset} disabled={loading || saving || !agent}>{t('common.resetDefault')}</button>
          <button className="dialog-btn primary" onClick={handleSave} disabled={loading || saving || !agent}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
