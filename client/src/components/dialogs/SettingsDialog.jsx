import { useEffect, useState } from 'react';
import { Palette, SlidersHorizontal, Brain, KeyRound, Minus, Plus, Plug, ChevronDown, ChevronRight, Trash2, Boxes } from 'lucide-react';
import { fetchConfig, saveConfig, saveExecution, saveTools, resetConfig, applyConfigProfile, saveMcpServer, deleteMcpServer, testMcpServer } from '../../api/config.js';
import { useTheme } from '../../theme/ThemeProvider.jsx';
import { useI18n, useT } from '../../i18n/I18nProvider.jsx';
import { DialogShell } from './DialogShell.jsx';

// Agent 行为参数（可写，下一次任务生效）。单位与后端 schema 一致，换算放消费点。
// label 改为 i18n key，渲染时经 t() 取文案。
const BASIC_AGENT_FIELDS = [
  { key: 'maxSteps', labelKey: 'settings.maxSteps' },
  { key: 'modelTimeoutSec', labelKey: 'settings.modelTimeoutSec' },
];

const ADVANCED_AGENT_FIELDS = [
  { key: 'maxOutputTokens', labelKey: 'settings.maxOutputTokens' },
  { key: 'staggerDelaySec', labelKey: 'settings.staggerDelaySec' },
  { key: 'batchSize', labelKey: 'settings.batchSize' },
  { key: 'maxHistorySteps', labelKey: 'settings.maxHistorySteps' },
  { key: 'maxResultChars', labelKey: 'settings.maxResultChars' },
];

const NUMBER_FIELD_STEPS = {
  modelTimeoutSec: 5,
  maxOutputTokens: 128,
  maxResultChars: 1000,
};

const THEME_OPTIONS = [
  { value: 'light', labelKey: 'appearance.theme.light' },
  { value: 'dark', labelKey: 'appearance.theme.dark' },
  { value: 'system', labelKey: 'appearance.theme.system' },
];

const FONT_SIZE_OPTIONS = [
  { value: 'small', labelKey: 'appearance.fontSize.small' },
  { value: 'standard', labelKey: 'appearance.fontSize.standard' },
  { value: 'large', labelKey: 'appearance.fontSize.large' },
];

const PROFILE_OPTIONS = ['fast', 'balanced', 'deep', 'safe'];

const DEFAULT_EXECUTION = {
  sandboxedWorkers: true,
  workerSandbox: true,
};

const DEFAULT_MCP_SERVERS = {
  chrome: {
    enabled: false,
    transport: { type: 'sse', url: 'http://127.0.0.1:3099/sse' },
    promptMode: 'lazy',
  },
  codex: {
    enabled: false,
    transport: { type: 'stdio', command: 'codex', args: ['mcp-server'], cwd: '.' },
    promptMode: 'lazy',
    toolTimeoutMs: 600000,
  },
};

// 设置分组：左侧导航 → 右侧内容。
const GROUPS = [
  { id: 'appearance', labelKey: 'settings.group.appearance', Icon: Palette },
  { id: 'agent', labelKey: 'settings.group.agent', Icon: SlidersHorizontal },
  { id: 'models', labelKey: 'settings.group.models', Icon: Boxes },
  { id: 'memory', labelKey: 'settings.group.memory', Icon: Brain },
  { id: 'mcp', labelKey: 'settings.group.mcp', Icon: Plug },
  { id: 'apiKeys', labelKey: 'settings.group.apiKeys', Icon: KeyRound },
];

// 设置面板：左导航分组 + 右内容。
// 外观（主题/语言，前台即时生效）、Agent 参数（保存后下次任务生效）、
// Worker 部署开关（保存后需重启）、记忆前端偏好和 API Key 只读展示。
export function SettingsDialog({ onClose, agentMemory, setAgentMemory, activeProjectId = null, projects = [] }) {
  const t = useT();
  const { theme, setTheme, fontSize, setFontSize } = useTheme();
  const { locale, setLocale } = useI18n();
  const [activeGroup, setActiveGroup] = useState('appearance');
  const [agent, setAgent] = useState(null);
  const [tools, setTools] = useState({ vision: {}, distill: {} });
  const [toolsScope, setToolsScope] = useState(activeProjectId || '');
  const [sources, setSources] = useState({});
  const [execution, setExecution] = useState(DEFAULT_EXECUTION);
  const [executionSources, setExecutionSources] = useState({});
  const [executionDirty, setExecutionDirty] = useState(false);
  const [schema, setSchema] = useState({});
  const [profile, setProfile] = useState('custom');
  const [profiles, setProfiles] = useState({});
  const [mcpServers, setMcpServers] = useState(DEFAULT_MCP_SERVERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState({});
  const [newMcpName, setNewMcpName] = useState('');
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const applyConfigData = data => {
    if (data.agent) setAgent(data.agent);
    if (data.tools) setTools({ vision: data.tools.vision || {}, distill: data.tools.distill || {} });
    if (data.sources) setSources(data.sources);
    if (data.execution) setExecution({ ...DEFAULT_EXECUTION, ...data.execution });
    if (data.executionSources) setExecutionSources(data.executionSources);
    if (data.schema) setSchema(data.schema);
    if (data.profile) setProfile(data.profile);
    if (data.profiles) setProfiles(data.profiles);
    if (data.mcpServers) {
      setMcpServers({
        ...data.mcpServers,
        chrome: data.mcpServers.chrome || DEFAULT_MCP_SERVERS.chrome,
        codex: data.mcpServers.codex || DEFAULT_MCP_SERVERS.codex,
      });
    }
  };

  useEffect(() => {
    let alive = true;
    fetchConfig(activeProjectId || undefined)
      .then(data => {
        if (!alive) return;
        applyConfigData(data);
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

  const setExecutionField = (key, value) => {
    setExecution(current => ({ ...current, [key]: value }));
    setExecutionDirty(true);
    setSaved(false);
  };

  const setToolModel = (tool, value) => {
    setTools(prev => ({ ...prev, [tool]: { model: value } }));
    setSaved(false);
  };

  const switchToolsScope = async scope => {
    setToolsScope(scope);
    setSaved(false);
    setError('');
    try {
      const data = await fetchConfig(scope || undefined);
      setTools({ vision: data.tools?.vision || {}, distill: data.tools?.distill || {} });
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSaveTools = async () => {
    setSaving(true);
    setError('');
    try {
      const data = await saveTools(tools, toolsScope || undefined);
      if (data.tools) setTools({ vision: data.tools.vision || {}, distill: data.tools.distill || {} });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const numberFieldLimit = key => {
    const fieldSchema = schema[key] || {};
    return {
      min: Number.isFinite(fieldSchema.min) ? fieldSchema.min : Number.MIN_SAFE_INTEGER,
      max: Number.isFinite(fieldSchema.max) ? fieldSchema.max : Number.MAX_SAFE_INTEGER,
      step: NUMBER_FIELD_STEPS[key] || 1,
    };
  };

  const clampNumberField = (key, value) => {
    const limit = numberFieldLimit(key);
    return Math.min(limit.max, Math.max(limit.min, value));
  };

  const stepNumberField = (key, direction) => {
    const limit = numberFieldLimit(key);
    const current = Number(agent[key]);
    const base = Number.isFinite(current) ? current : limit.min;
    setField(key, clampNumberField(key, base + direction * limit.step));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    const shouldSaveExecution = executionDirty;
    try {
      // 先保存热生效的 Agent 参数，再按需保存需要重启的 Worker 部署选项。
      const agentData = await saveConfig(agent);
      let data = agentData;
      if (shouldSaveExecution) {
        const executionPatch = { sandboxedWorkers: execution.sandboxedWorkers };
        // 环境变量覆盖的字段不可由 UI 回写，避免覆盖用户在配置文件里保存的值。
        if (executionSources.workerSandbox !== 'env') executionPatch.workerSandbox = execution.workerSandbox;
        const executionData = await saveExecution(executionPatch);
        data = { ...agentData, ...executionData };
      }
      applyConfigData(data);
      setExecutionDirty(false);
      if (shouldSaveExecution) setRestartRequired(true);
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
      applyConfigData(data);
      setExecutionDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleProfile = async nextProfile => {
    setSaving(true);
    setError('');
    try {
      const data = await applyConfigProfile(nextProfile);
      applyConfigData(data);
      setExecutionDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const updateMcp = (name, updater) => {
    setMcpServers(current => ({
      ...current,
      [name]: updater(current[name] || DEFAULT_MCP_SERVERS[name]),
    }));
    setMcpStatus(current => ({ ...current, [name]: null }));
  };

  const handleSaveMcp = async name => {
    setMcpStatus(current => ({ ...current, [name]: { loading: true } }));
    try {
      const data = await saveMcpServer(name, mcpServers[name]);
      setMcpServers(current => ({ ...current, [name]: data.mcpServers[name] }));
      setMcpStatus(current => ({ ...current, [name]: { ok: true, message: t('settings.mcpSaved') } }));
      return true;
    } catch (e) {
      setMcpStatus(current => ({ ...current, [name]: { ok: false, message: e.message } }));
      return false;
    }
  };

  const handleTestMcp = async name => {
    if (!await handleSaveMcp(name)) return;
    setMcpStatus(current => ({ ...current, [name]: { loading: true } }));
    try {
      const data = await testMcpServer(name);
      setMcpStatus(current => ({
        ...current,
        [name]: { ok: true, message: t('settings.mcpConnected', { count: data.toolCount }) },
      }));
    } catch (e) {
      setMcpStatus(current => ({ ...current, [name]: { ok: false, message: e.message } }));
    }
  };

  const handleAddMcp = () => {
    const name = newMcpName.trim();
    if (!name || mcpServers[name]) return;
    setMcpServers(current => ({
      ...current,
      [name]: { enabled: false, transport: { type: 'stdio', command: '', args: [], cwd: '.' }, promptMode: 'lazy' },
    }));
    setNewMcpName('');
  };

  const handleDeleteMcp = async name => {
    try {
      await deleteMcpServer(name);
      setMcpServers(current => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    } catch (e) {
      setMcpStatus(current => ({ ...current, [name]: { ok: false, message: e.message } }));
    }
  };

  const numberField = (key, labelKey) => {
    const limit = numberFieldLimit(key);
    const value = Number(agent[key]);
    const displayValue = Number.isFinite(value) ? value : limit.min;
    return (
      <div key={key} className="settings-field">
        <span className="settings-field-label">
          <span>{t(labelKey)}</span>
          {sources[key] && <small>{t(`settings.source.${sources[key]}`)}</small>}
        </span>
        <div className="settings-stepper">
          <button
            type="button"
            className="settings-stepper-btn"
            onClick={() => stepNumberField(key, -1)}
            disabled={displayValue <= limit.min}
            aria-label={`${t(labelKey)} -`}
            title={`${t(labelKey)} -`}
          >
            <Minus size={16} strokeWidth={2} />
          </button>
          <span className="settings-stepper-value">
            {displayValue.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}
          </span>
          <button
            type="button"
            className="settings-stepper-btn"
            onClick={() => stepNumberField(key, 1)}
            disabled={displayValue >= limit.max}
            aria-label={`${t(labelKey)} +`}
            title={`${t(labelKey)} +`}
          >
            <Plus size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    );
  };

  // 需要后端配置的分组在未加载/加载失败时给出占位。
  const renderBackendGuard = () => {
    if (loading) return <p className="dialog-desc">{t('common.loading')}</p>;
    if (!agent) return <p className="settings-error">{error || t('common.loadFailed')}</p>;
    return null;
  };

  const workerSandboxDisabled = !execution.sandboxedWorkers || executionSources.workerSandbox === 'env';

  const renderMcpServer = name => {
    const fallback = DEFAULT_MCP_SERVERS[name] || { enabled: false, transport: { type: 'stdio', command: '', args: [], cwd: '.' } };
    const server = mcpServers[name] || fallback;
    const transport = server.transport || fallback.transport;
    const status = mcpStatus[name];
    const builtin = name === 'chrome';
    const title = name === 'chrome' ? 'Chrome DevTools' : name === 'codex' ? 'Codex CLI' : name;
    return (
      <div key={name} className="settings-mcp-card">
        <div className="settings-mcp-heading">
          <strong>{title}</strong>
          <label className="settings-mcp-enabled">
            <span>{t('settings.mcpEnabled')}</span>
            <input
              type="checkbox"
              checked={!!server.enabled}
              onChange={e => updateMcp(name, current => ({ ...current, enabled: e.target.checked }))}
            />
          </label>
        </div>
        <div className="settings-mcp-grid">
          <label className="settings-field">
            <span>{t('settings.mcpTransport')}</span>
            <select
              value={transport.type}
              onChange={e => updateMcp(name, current => ({
                ...current,
                transport: e.target.value === 'stdio'
                  ? { type: 'stdio', command: 'npx', args: [] }
                  : e.target.value === 'http'
                    ? { type: 'http', url: 'http://127.0.0.1:3000/mcp' }
                    : { type: 'sse', url: name === 'chrome' ? 'http://127.0.0.1:3099/sse' : 'http://127.0.0.1:6365/sse' },
              }))}
            >
              <option value="sse">SSE</option>
              {!builtin && <option value="http">Streamable HTTP</option>}
              {name !== 'chrome' && <option value="stdio">stdio</option>}
            </select>
          </label>
          {transport.type === 'sse' || transport.type === 'http' ? (
            <label className="settings-field settings-mcp-wide">
              <span>URL</span>
              <input
                value={transport.url || ''}
                onChange={e => updateMcp(name, current => ({
                  ...current,
                  transport: { ...current.transport, type: transport.type, url: e.target.value },
                }))}
              />
            </label>
          ) : (
            <>
              <label className="settings-field">
                <span>{t('settings.mcpCommand')}</span>
                <input
                  value={transport.command || ''}
                  onChange={e => updateMcp(name, current => ({
                    ...current,
                    transport: { ...current.transport, type: 'stdio', command: e.target.value },
                  }))}
                />
              </label>
              <label className="settings-field settings-mcp-wide">
                <span>{t('settings.mcpArgs')}</span>
                <input
                  value={(transport.args || []).join(' ')}
                  onChange={e => updateMcp(name, current => ({
                    ...current,
                    transport: { ...current.transport, type: 'stdio', args: e.target.value.split(/\s+/).filter(Boolean) },
                  }))}
                />
              </label>
              <label className="settings-field settings-mcp-wide">
                <span>CWD</span>
                <input
                  value={transport.cwd || '.'}
                  onChange={e => updateMcp(name, current => ({
                    ...current,
                    transport: { ...current.transport, type: 'stdio', cwd: e.target.value },
                  }))}
                />
              </label>
            </>
          )}
          <label className="settings-field">
            <span>{t('settings.mcpToolTimeoutSec')}</span>
            <input
              type="number"
              min="1"
              max="3600"
              step="1"
              value={Math.round((server.toolTimeoutMs || (name === 'codex' ? 600000 : 60000)) / 1000)}
              onChange={e => updateMcp(name, current => ({
                ...current,
                toolTimeoutMs: Math.max(1000, Math.min(3600000, (Number(e.target.value) || 1) * 1000)),
              }))}
            />
          </label>
        </div>
        <div className="settings-mcp-actions">
          <button type="button" className="dialog-btn" onClick={() => handleSaveMcp(name)} disabled={status?.loading}>{t('common.save')}</button>
          <button type="button" className="dialog-btn primary" onClick={() => handleTestMcp(name)} disabled={status?.loading || !server.enabled}>{t('settings.mcpTest')}</button>
          {!builtin && name !== 'codex' && (
            <button type="button" className="dialog-btn" onClick={() => handleDeleteMcp(name)} disabled={status?.loading} title={t('settings.mcpDelete')}>
              <Trash2 size={15} />
            </button>
          )}
          {status?.message && <span className={status.ok ? 'settings-ok' : 'settings-error'}>{status.message}</span>}
        </div>
      </div>
    );
  };

  const renderGroup = () => {
    if (activeGroup === 'appearance') {
      return (
        <div className="settings-section">
          <div className="settings-appearance-stack">
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
            <div className="settings-field settings-field-switch">
              <span>{t('appearance.fontSize')}</span>
              <div className="settings-segment">
                {FONT_SIZE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    className={`settings-segment-btn${fontSize === opt.value ? ' active' : ''}`}
                    onClick={() => setFontSize(opt.value)}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (activeGroup === 'agent') {
      return (
        <div className="settings-section">
          <p className="dialog-desc">{t('settings.agentParamsDesc')}</p>
          {renderBackendGuard() || (
            <>
              <div className="settings-profile-row">
                <span>{t('settings.profile')}</span>
                <div className="settings-segment">
                  {PROFILE_OPTIONS.map(item => (
                    <button
                      key={item}
                      type="button"
                      className={`settings-segment-btn${profile === item ? ' active' : ''}`}
                      onClick={() => handleProfile(item)}
                      disabled={saving || !profiles[item]}
                    >{t(`settings.profile.${item}`)}</button>
                  ))}
                </div>
              </div>
              <div className="settings-grid">
                {BASIC_AGENT_FIELDS.map(f => numberField(f.key, f.labelKey))}
                <label className="settings-field settings-field-switch">
                  <span>{t('settings.autoModelRouting')}</span>
                  <input
                    type="checkbox"
                    checked={!!agent.autoModelRouting}
                    onChange={e => setField('autoModelRouting', e.target.checked)}
                  />
                </label>
              </div>
              <button type="button" className="settings-advanced-toggle" onClick={() => setAdvancedOpen(open => !open)}>
                {advancedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                {t('settings.advanced')}
              </button>
              {advancedOpen && (
                <>
                  <div className="settings-grid settings-advanced-grid">
                    {ADVANCED_AGENT_FIELDS.map(f => numberField(f.key, f.labelKey))}
                    <label className="settings-field settings-field-switch">
                      <span className="settings-field-label">
                        <span>{t('settings.observeDesktop')}</span>
                        {sources.observeDesktop && <small>{t(`settings.source.${sources.observeDesktop}`)}</small>}
                      </span>
                      <input
                        type="checkbox"
                        checked={!!agent.observeDesktop}
                        onChange={e => setField('observeDesktop', e.target.checked)}
                      />
                    </label>
                    <label className="settings-field settings-field-switch">
                      <span className="settings-field-label">
                        <span>{t('settings.sandboxedWorkers')}</span>
                        {executionSources.sandboxedWorkers && <small>{t(`settings.source.${executionSources.sandboxedWorkers}`)}</small>}
                      </span>
                      <input
                        type="checkbox"
                        checked={!!execution.sandboxedWorkers}
                        onChange={e => setExecutionField('sandboxedWorkers', e.target.checked)}
                        disabled={saving}
                      />
                    </label>
                    <label className="settings-field settings-field-switch">
                      <span className="settings-field-label">
                        <span>{t('settings.workerSandbox')}</span>
                        {executionSources.workerSandbox && <small>{t(`settings.source.${executionSources.workerSandbox}`)}</small>}
                      </span>
                      <input
                        type="checkbox"
                        checked={!!execution.workerSandbox}
                        onChange={e => setExecutionField('workerSandbox', e.target.checked)}
                        disabled={saving || workerSandboxDisabled}
                        title={executionSources.workerSandbox === 'env' ? t('settings.workerSandboxEnvOverride') : undefined}
                      />
                    </label>
                  </div>
                  <p className="dialog-desc">{t('settings.executionRestartDesc')}</p>
                  {executionSources.workerSandbox === 'env' && (
                    <p className="dialog-desc">{t('settings.workerSandboxEnvOverride')}</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      );
    }

    if (activeGroup === 'models') {
      return (
        <div className="settings-section">
          <p className="dialog-desc">{t('settings.modelsDesc')}</p>
          {renderBackendGuard() || (
            <div className="settings-grid">
              <label className="settings-field">
                <span>{t('settings.toolsScope')}</span>
                <select value={toolsScope} onChange={e => switchToolsScope(e.target.value)} disabled={saving}>
                  <option value="">{t('settings.scopeGlobal')}</option>
                  {projects.map(p => (
                    <option key={p.projectId} value={p.projectId}>{p.name || p.projectId}</option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                <span>{t('settings.visionModel')}</span>
                <input
                  list="tool-model-suggestions"
                  value={tools.vision?.model || ''}
                  placeholder={t('settings.toolModelPlaceholder')}
                  onChange={e => setToolModel('vision', e.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>{t('settings.distillModel')}</span>
                <input
                  list="tool-model-suggestions"
                  value={tools.distill?.model || ''}
                  placeholder={t('settings.toolModelPlaceholder')}
                  onChange={e => setToolModel('distill', e.target.value)}
                />
              </label>
              <datalist id="tool-model-suggestions">
                <option value="nvidia/ising-calibration-1-35b-a3b" />
              </datalist>
            </div>
          )}
        </div>
      );
    }

    if (activeGroup === 'memory') {
      return (
        <div className="settings-section">
          <p className="dialog-desc">{t('settings.memoryDesc')}</p>
          <div className="settings-grid">
            <label className="settings-field settings-field-switch">
              <span>{t('settings.memoryEnabled')}</span>
              <input
                type="checkbox"
                checked={!!agentMemory}
                onChange={e => setAgentMemory(e.target.checked)}
              />
            </label>
          </div>
        </div>
      );
    }

    if (activeGroup === 'mcp') {
      return (
        <div className="settings-section">
          <p className="dialog-desc">{t('settings.mcpDesc')}</p>
          {renderBackendGuard() || (
            <div className="settings-mcp-list">
              {renderMcpServer('chrome')}
              {renderMcpServer('codex')}
              {Object.keys(mcpServers)
                .filter(name => !['chrome', 'codex'].includes(name))
                .sort()
                .map(renderMcpServer)}
              <div className="settings-mcp-card">
                <div className="settings-mcp-actions">
                  <input
                    value={newMcpName}
                    onChange={e => setNewMcpName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddMcp(); }}
                    placeholder={t('settings.mcpNamePlaceholder')}
                  />
                  <button type="button" className="dialog-btn" onClick={handleAddMcp} disabled={!newMcpName.trim() || !!mcpServers[newMcpName.trim()]}>{t('settings.mcpAdd')}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // apiKeys
    return (
      <div className="settings-section">
        <p className="dialog-desc">{t('settings.apiKeysDesc')}</p>
        {renderBackendGuard() || (
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
        )}
      </div>
    );
  };

  // Agent 页保存热配置及已修改的 execution，Models 页保存工具覆盖；
  // 外观/记忆是即时前端偏好，Memory 页沿用现有共享 footer。
  const showSaveBar = activeGroup === 'agent' || activeGroup === 'memory' || activeGroup === 'models';
  const activeGroupLabel = t(GROUPS.find(group => group.id === activeGroup)?.labelKey || 'settings.title');

  return (
    <DialogShell
      title={t('settings.title')}
      subtitle={activeGroupLabel}
      onClose={onClose}
      closeDisabled={saving}
      maskClassName="settings-mask"
      dialogClassName="settings-dialog"
      footer={showSaveBar ? (
        <div className="settings-dialog-footer">
          {activeGroup !== 'models' && (
            <button type="button" className="dialog-btn" onClick={handleReset} disabled={loading || saving || !agent}>{t('common.resetDefault')}</button>
          )}
          <button type="button" className="dialog-btn primary" onClick={activeGroup === 'models' ? handleSaveTools : handleSave} disabled={loading || saving || !agent}>{t('common.save')}</button>
        </div>
      ) : null}
    >
        <div className="settings-layout settings-dialog-body">
          <nav className="settings-nav">
            {GROUPS.map(g => (
              <button
                key={g.id}
                className={`settings-nav-btn${activeGroup === g.id ? ' active' : ''}`}
                onClick={() => setActiveGroup(g.id)}
              >
                <g.Icon size={16} strokeWidth={2} className="settings-nav-icon" />
                {t(g.labelKey)}
              </button>
            ))}
          </nav>

          <div className="settings-content settings-dialog-content">
            {renderGroup()}
            {showSaveBar && error && <p className="settings-error">{error}</p>}
            {showSaveBar && saved && !error && <p className="settings-ok">{t('common.saved')}</p>}
            {activeGroup === 'agent' && restartRequired && !error && <p className="settings-ok">{t('settings.executionRestartSaved')}</p>}
          </div>
        </div>

    </DialogShell>
  );
}
