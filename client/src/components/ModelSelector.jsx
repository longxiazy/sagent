import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Search, Check } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

function filterModels(models, query) {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(m =>
    m.id.toLowerCase().includes(q) || (m.label && m.label.toLowerCase().includes(q))
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
function ChatModelDropdown({ availableModels, chatModel, setChatModel, sessionLocked, currentProvider }) {
  const t = useT();
  const { open, setOpen, wrapRef, inputRef } = useDropdown();
  const [query, setQuery] = useState('');

  const selected = availableModels.find(m => m.id === chatModel);
  const selectedLabel = selected?.label || chatModel || t('modelSelector.selectModel');
  const filtered = useMemo(() => filterModels(availableModels, query), [availableModels, query]);

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
          {currentProvider && (
            <span className="model-dropdown-provider" title={t('modelSelector.providerTitle', { provider: currentProvider })}>
              {currentProvider}
            </span>
          )}
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
            {filtered.map(item => (
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
  currentProvider,
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
  const q = query.trim().toLowerCase();
  const selectedSet = new Set(selectedAgentModels);
  const selectedItems = selectedAgentModels
    .map(id => availableModels.find(m => m.id === id))
    .filter(Boolean);
  const unselectedItems = availableModels.filter(m => !selectedSet.has(m.id));
  const filteredUnselected = q
    ? unselectedItems.filter(m => m.id.toLowerCase().includes(q) || (m.label && m.label.toLowerCase().includes(q)))
    : unselectedItems;
  const visibleItems = [...selectedItems, ...filteredUnselected];

  const count = selectedAgentModels.length;
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
          {item.label}
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
          {currentProvider && (
            <span className="model-dropdown-provider" title={t('modelSelector.providerTitle', { provider: currentProvider })}>
              {currentProvider}
            </span>
          )}
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
          <div className="model-tags">
            {visibleItems.length === 0 && <span className="model-tags-empty">{t('modelSelector.noMatch')}</span>}
            {visibleItems.map(renderTag)}
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
  currentProvider,
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
          currentProvider={currentProvider}
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
        currentProvider={currentProvider}
      />
    </div>
  );
}
