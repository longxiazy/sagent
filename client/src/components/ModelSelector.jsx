import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Search, Check } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

function filterModels(models, query) {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(m =>
    m.id.toLowerCase().includes(q)
      || (m.label && m.label.toLowerCase().includes(q))
      || (m.provider && m.provider.toLowerCase().includes(q))
  );
}

function providerOf(model) {
  return model?.provider || 'unknown';
}

function groupByProvider(models) {
  const groups = [];
  const byName = new Map();
  for (const model of models) {
    const provider = providerOf(model);
    if (!byName.has(provider)) {
      const group = { provider, models: [] };
      byName.set(provider, group);
      groups.push(group);
    }
    byName.get(provider).models.push(model);
  }
  return groups;
}

function ProviderPill({ provider }) {
  if (!provider) return null;
  return (
    <span className="model-dropdown-provider" title={provider}>
      {provider}
    </span>
  );
}

// 浮层下拉的通用交互：点击外部关闭、ESC 关闭。
// chat / agent 两种模型选择器共用这套逻辑。
function useDropdown() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return { open, setOpen, wrapRef, inputRef };
}

// chat 模式：可搜索的下拉。供应商接口可能返回上百个模型，原生 <select> 没法选，
// 这里做成「点击展开 → 输入过滤 → 点选」的浮层。
function ChatModelDropdown({ availableModels, chatModel, setChatModel, sessionLocked }) {
  const t = useT();
  const { open, setOpen, wrapRef, inputRef } = useDropdown();
  const [query, setQuery] = useState('');

  const selected = availableModels.find(m => m.id === chatModel);
  const selectedLabel = selected?.label || chatModel || t('modelSelector.selectModel');
  const filtered = useMemo(() => filterModels(availableModels, query), [availableModels, query]);
  const grouped = useMemo(() => groupByProvider(filtered), [filtered]);

  const openPanel = () => {
    setQuery('');
    setOpen(o => !o);
  };

  return (
    <div className="model-dropdown" ref={wrapRef}>
      <button
        type="button"
        className="model-dropdown-trigger"
        onClick={openPanel}
        disabled={sessionLocked}
        title={t('modelSelector.switchModel')}
      >
        <span className="model-dropdown-main">
          <ProviderPill provider={selected?.provider} />
          <span className="model-dropdown-label">{selectedLabel}</span>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="model-dropdown-panel">
          <div className="model-dropdown-search">
            <Search size={13} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('modelSelector.searchPlaceholder')}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
            />
          </div>
          <div className="model-dropdown-list">
            {filtered.length === 0 && <div className="model-dropdown-empty">{t('modelSelector.noMatch')}</div>}
            {grouped.map(group => (
              <div key={group.provider} className="model-provider-group">
                <div className="model-provider-heading">{group.provider}</div>
                {group.models.map(item => (
                  <button
                    type="button"
                    key={item.id}
                    className={`model-dropdown-option ${item.id === chatModel ? 'selected' : ''}`}
                    onClick={() => { setChatModel(item.id); setOpen(false); }}
                    title={item.id}
                  >
                    <span className="model-dropdown-option-label">{item.label}</span>
                    {item.id === chatModel && <Check size={13} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// agent 模式：多选 + 优先级排序 + race/vote 策略。
// 收进与 chat 同构的浮层：触发按钮显示已选数量，展开后在面板内搜索/多选/排序/切策略，
// 避免一排模型标签直接铺在输入卡工具栏里把版面撑乱。
function AgentModelDropdown({
  availableModels,
  selectedAgentModels,
  setSelectedAgentModels,
  agentStrategy,
  setAgentStrategy,
  sessionLocked,
}) {
  const t = useT();
  const { open, setOpen, wrapRef, inputRef } = useDropdown();
  const [query, setQuery] = useState('');

  const openPanel = () => {
    setQuery('');
    setOpen(o => !o);
  };

  const toggleAgentModel = id => {
    setSelectedAgentModels(prev => (prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]));
  };

  const moveAgentModel = (id, dir) => {
    setSelectedAgentModels(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  // 已选模型始终置顶且不受搜索影响，避免选中后被过滤掉看不到。
  const selectedSet = new Set(selectedAgentModels);
  const selectedItems = selectedAgentModels
    .map(id => availableModels.find(m => m.id === id))
    .filter(Boolean);
  const unselectedItems = availableModels.filter(m => !selectedSet.has(m.id));
  const filteredUnselected = filterModels(unselectedItems, query);
  const visibleItems = [...selectedItems, ...filteredUnselected];
  // visibleItems 每次渲染都是新数组,手动 useMemo 反而被 React Compiler 拒绝优化;
  // 这里直接调用,交给编译器自动 memo(与 ChatModelDropdown 不同——那边依赖的是已 memo 的 filtered)。
  const grouped = groupByProvider(visibleItems);

  const count = selectedAgentModels.length;
  const selectedProviders = [...new Set(selectedItems.map(providerOf))];
  const triggerProvider = count === 0
    ? null
    : selectedProviders.length === 1
      ? selectedProviders[0]
      : t('modelSelector.providerCount', { count: selectedProviders.length });
  const triggerLabel = count === 1
    ? (selectedItems[0]?.label || selectedAgentModels[0])
    : count > 1
      ? t('modelSelector.selectedCount', { count })
      : t('modelSelector.selectModels');

  const renderTag = item => {
    const isSelected = selectedSet.has(item.id);
    const orderIdx = selectedAgentModels.indexOf(item.id);
    return (
      <span key={item.id} className={`model-tag-wrapper ${isSelected ? 'selected' : ''}`}>
        <button
          className={`model-tag ${isSelected ? 'selected' : ''}`}
          onClick={() => toggleAgentModel(item.id)}
          disabled={sessionLocked}
          title={isSelected ? t('modelSelector.deselect') : t('modelSelector.selectConcurrent')}
        >
          <span className="model-tag-label">{item.label}</span>
        </button>
        {isSelected && selectedAgentModels.length > 1 && (
          <span className="model-tag-order">
            <button className="order-arrow" onClick={() => moveAgentModel(item.id, -1)} disabled={orderIdx <= 0 || sessionLocked} title={t('modelSelector.raisePriority')}><ChevronUp size={10} /></button>
            <span className="order-number">{orderIdx + 1}</span>
            <button className="order-arrow" onClick={() => moveAgentModel(item.id, 1)} disabled={orderIdx >= selectedAgentModels.length - 1 || sessionLocked} title={t('modelSelector.lowerPriority')}><ChevronDown size={10} /></button>
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="model-dropdown" ref={wrapRef}>
      <button
        type="button"
        className={`model-dropdown-trigger ${count > 0 ? 'has-selection' : ''}`}
        onClick={openPanel}
        disabled={sessionLocked}
        title={t('modelSelector.switchModel')}
      >
        <span className="model-dropdown-main">
          <ProviderPill provider={triggerProvider} />
          <span className="model-dropdown-label">{triggerLabel}</span>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="model-dropdown-panel agent-model-panel">
          <div className="model-dropdown-search">
            <Search size={13} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('modelSelector.searchPlaceholder')}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
              disabled={sessionLocked}
            />
          </div>
          {count > 0 && (
            <div className="model-dropdown-actions">
              <span className="model-dropdown-count">{t('modelSelector.selectedCount', { count })}</span>
              <button
                type="button"
                className="model-clear-btn"
                onClick={() => setSelectedAgentModels([])}
                disabled={sessionLocked}
              >{t('modelSelector.clearAll')}</button>
            </div>
          )}
          <div className="model-tags">
            {visibleItems.length === 0 && <span className="model-tags-empty">{t('modelSelector.noMatch')}</span>}
            {grouped.map(group => (
              <div key={group.provider} className="model-provider-group">
                <div className="model-provider-heading">{group.provider}</div>
                <div className="model-provider-tags">
                  {group.models.map(renderTag)}
                </div>
              </div>
            ))}
          </div>
          {selectedAgentModels.length > 1 && (
            <div className="strategy-toggle">
              <button
                className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
                onClick={() => setAgentStrategy('race')}
                disabled={sessionLocked}
                title={t('modelSelector.raceTitle')}
              >{t('modelSelector.race')}</button>
              <button
                className={`strategy-btn ${agentStrategy === 'vote' ? 'active' : ''}`}
                onClick={() => setAgentStrategy('vote')}
                disabled={sessionLocked}
                title={t('modelSelector.voteTitle')}
              >{t('modelSelector.vote')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 模型选择控件：
// - chat 模式：可搜索下拉
// - agent 模式：多选下拉（搜索 + 多选 + 优先级排序 + race/vote 策略）
//
// 只在 sessionStarted=false 时渲染。组件自己判断这个条件，让 App
// 那边可以无条件 <ModelSelector .../> 写成一行。
export function ModelSelector({
  sessionStarted,
  mode,
  availableModels,
  chatModel,
  setChatModel,
  selectedAgentModels,
  setSelectedAgentModels,
  agentStrategy,
  setAgentStrategy,
  sessionLocked,
}) {
  if (sessionStarted) return null;

  if (mode !== 'agent') {
    return (
      <div className="model-select-row">
        <ChatModelDropdown
          availableModels={availableModels}
          chatModel={chatModel}
          setChatModel={setChatModel}
          sessionLocked={sessionLocked}
        />
      </div>
    );
  }

  return (
    <div className="model-select-row">
      <AgentModelDropdown
        availableModels={availableModels}
        selectedAgentModels={selectedAgentModels}
        setSelectedAgentModels={setSelectedAgentModels}
        agentStrategy={agentStrategy}
        setAgentStrategy={setAgentStrategy}
        sessionLocked={sessionLocked}
      />
    </div>
  );
}
