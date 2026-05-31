import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Search, Check } from 'lucide-react';

function filterModels(models, query) {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(m =>
    m.id.toLowerCase().includes(q) || (m.label && m.label.toLowerCase().includes(q))
  );
}

// chat 模式：可搜索的下拉。供应商接口可能返回上百个模型，原生 <select> 没法选，
// 这里做成「点击展开 → 输入过滤 → 点选」的浮层。
function ChatModelDropdown({ availableModels, chatModel, setChatModel, sessionLocked }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const selected = availableModels.find(m => m.id === chatModel);
  const selectedLabel = selected?.label || chatModel || '选择模型';
  const filtered = useMemo(() => filterModels(availableModels, query), [availableModels, query]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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
        title="切换模型"
      >
        <span className="model-dropdown-label">{selectedLabel}</span>
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
              placeholder="搜索模型…"
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
            />
          </div>
          <div className="model-dropdown-list">
            {filtered.length === 0 && <div className="model-dropdown-empty">无匹配模型</div>}
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

// 模型选择控件：
// - chat 模式：可搜索下拉
// - agent 模式：多选 tag + 优先级排序 + race/vote 策略切换
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
  const [query, setQuery] = useState('');

  if (sessionStarted) return null;

  const providerBadge = currentProvider
    ? <span className="provider-badge" title={`当前供应商：${currentProvider}`}>{currentProvider}</span>
    : null;

  if (mode !== 'agent') {
    return (
      <div className="model-select-row">
        {providerBadge}
        <ChatModelDropdown
          availableModels={availableModels}
          chatModel={chatModel}
          setChatModel={setChatModel}
          sessionLocked={sessionLocked}
        />
      </div>
    );
  }

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

  const renderTag = item => {
    const isSelected = selectedSet.has(item.id);
    const orderIdx = selectedAgentModels.indexOf(item.id);
    return (
      <span key={item.id} className={`model-tag-wrapper ${isSelected ? 'selected' : ''}`}>
        <button
          className={`model-tag ${isSelected ? 'selected' : ''}`}
          onClick={() => toggleAgentModel(item.id)}
          disabled={sessionLocked}
          title={isSelected ? '取消选择' : '选择并发执行'}
        >
          {item.label}
        </button>
        {isSelected && selectedAgentModels.length > 1 && (
          <span className="model-tag-order">
            <button className="order-arrow" onClick={() => moveAgentModel(item.id, -1)} disabled={orderIdx <= 0 || sessionLocked} title="提高优先级"><ChevronUp size={10} /></button>
            <span className="order-number">{orderIdx + 1}</span>
            <button className="order-arrow" onClick={() => moveAgentModel(item.id, 1)} disabled={orderIdx >= selectedAgentModels.length - 1 || sessionLocked} title="降低优先级"><ChevronDown size={10} /></button>
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="model-tags-wrap">
      <div className="model-tags-search">
        {providerBadge}
        <Search size={13} />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索模型…"
          disabled={sessionLocked}
        />
      </div>
      <div className="model-tags">
        {visibleItems.length === 0 && <span className="model-tags-empty">无匹配模型</span>}
        {visibleItems.map(renderTag)}
      </div>
      {selectedAgentModels.length > 1 && (
        <div className="strategy-toggle">
          <button
            className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
            onClick={() => setAgentStrategy('race')}
            disabled={sessionLocked}
            title="按优先级分批启动，先到先得"
          >竞速</button>
          <button
            className={`strategy-btn ${agentStrategy === 'vote' ? 'active' : ''}`}
            onClick={() => setAgentStrategy('vote')}
            disabled={sessionLocked}
            title="等待所有模型完成，投票选最优"
          >汇总</button>
        </div>
      )}
    </div>
  );
}
