import { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

function formatTokenLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(0)}K`;
  }
  return String(n);
}

function asList(value) {
  return Array.isArray(value)
    ? value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function formatList(value, limit = 3) {
  const items = asList(value);
  if (!items.length) return null;
  const visible = items.slice(0, limit).join('+');
  return items.length > limit ? `${visible}+${items.length - limit}` : visible;
}

function modelFacts(model) {
  const facts = [];
  const context = formatTokenLimit(model?.contextWindow || model?.context_length || model?.inputTokenLimit);
  const output = formatTokenLimit(model?.maxOutputTokens || model?.outputTokenLimit);
  const inputModalities = formatList(model?.inputModalities || model?.input_modalities);
  const outputModalities = formatList(model?.outputModalities || model?.output_modalities);
  const messageTypes = formatList(model?.supportedMessageTypes || model?.supported_message_types);
  const messageRoles = formatList(model?.supportedMessageRoles || model?.supported_message_roles);
  const methods = formatList(model?.supportedGenerationMethods || model?.supported_generation_methods);
  const parameters = formatList(model?.supportedParameters || model?.supported_parameters);

  if (context) facts.push({ label: 'CTX', value: context });
  if (output) facts.push({ label: 'MAX', value: output });
  if (inputModalities) facts.push({ label: 'IN', value: inputModalities });
  if (outputModalities) facts.push({ label: 'OUT', value: outputModalities });
  if (messageTypes) facts.push({ label: 'MSG', value: messageTypes });
  if (messageRoles) facts.push({ label: 'ROLE', value: messageRoles });
  if (methods) facts.push({ label: 'GEN', value: methods });
  if (parameters) facts.push({ label: 'CAP', value: parameters });
  return facts;
}

function modelSearchText(model) {
  return [
    model?.id,
    model?.label,
    model?.provider,
    model?.description,
    model?.catalogUrl,
    ...modelFacts(model).flatMap(fact => [fact.label, fact.value]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function filterModels(models, query) {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(m => modelSearchText(m).includes(q));
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

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function modelContextTokens(model) {
  const n = Number(model?.contextWindow || model?.context_length || model?.inputTokenLimit);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function modelModalities(model) {
  return uniqueSorted([
    ...asList(model?.inputModalities || model?.input_modalities),
    ...asList(model?.outputModalities || model?.output_modalities),
  ]);
}

function modelCapabilities(model) {
  return uniqueSorted([
    ...asList(model?.supportedParameters || model?.supported_parameters),
    ...asList(model?.supportedGenerationMethods || model?.supported_generation_methods),
    ...asList(model?.supportedMessageTypes || model?.supported_message_types),
  ]);
}

function countOptions(models, getter) {
  const counts = new Map();
  for (const model of models) {
    for (const value of getter(model)) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

function matchesComplexFilters(model, filters) {
  if (filters.provider !== 'all' && providerOf(model) !== filters.provider) return false;
  if (filters.modality !== 'all' && !modelModalities(model).includes(filters.modality)) return false;
  if (filters.capability !== 'all' && !modelCapabilities(model).includes(filters.capability)) return false;

  const context = modelContextTokens(model);
  if (filters.context === 'known' && !context) return false;
  if (filters.context === 'unknown' && context) return false;
  if (filters.context === '128k' && (!context || context < 128_000)) return false;
  if (filters.context === '200k' && (!context || context < 200_000)) return false;
  if (filters.context === '1m' && (!context || context < 1_000_000)) return false;
  return true;
}

function ProviderPill({ provider }) {
  if (!provider) return null;
  return (
    <span className="model-dropdown-provider" title={provider}>
      {provider}
    </span>
  );
}

// 模型选择弹框的通用交互：打开后聚焦搜索、ESC 关闭。
function useModelPickerDialog() {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onKeyDown = e => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return { open, setOpen, inputRef };
}

// Agent 模式：多选 + 优先级排序 + race/vote 策略。
// 触发按钮显示已选数量，展开后在面板内搜索/多选/排序/切策略，
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
  const { open, setOpen, inputRef } = useModelPickerDialog();
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [modalityFilter, setModalityFilter] = useState('all');
  const [capabilityFilter, setCapabilityFilter] = useState('all');
  const [contextFilter, setContextFilter] = useState('all');

  const openPanel = () => {
    setQuery('');
    setOpen(o => !o);
  };

  const resetFilters = () => {
    setQuery('');
    setProviderFilter('all');
    setModalityFilter('all');
    setCapabilityFilter('all');
    setContextFilter('all');
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
  const filters = {
    provider: providerFilter,
    modality: modalityFilter,
    capability: capabilityFilter,
    context: contextFilter,
  };
  const filteredUnselected = filterModels(unselectedItems, query)
    .filter(model => matchesComplexFilters(model, filters));
  // 筛选结果每次渲染都是新数组,手动 useMemo 反而被 React Compiler 拒绝优化;
  // 这里直接调用,交给编译器自动 memo。
  const grouped = groupByProvider(filteredUnselected);
  const providerOptions = groupByProvider(availableModels).map(group => ({
    value: group.provider,
    count: group.models.length,
  }));
  const modalityOptions = countOptions(availableModels, modelModalities).slice(0, 10);
  const capabilityOptions = countOptions(availableModels, modelCapabilities).slice(0, 12);
  const visibleCount = selectedItems.length + filteredUnselected.length;
  const activeFilterCount = [
    providerFilter !== 'all',
    modalityFilter !== 'all',
    capabilityFilter !== 'all',
    contextFilter !== 'all',
    Boolean(query.trim()),
  ].filter(Boolean).length;

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
    const facts = modelFacts(item);
    const factTitle = facts.map(fact => `${fact.label} ${fact.value}`).join(' · ');
    return (
      <span key={item.id} className={`model-tag-wrapper ${isSelected ? 'selected' : ''}`}>
        <button
          className={`model-tag ${isSelected ? 'selected' : ''}`}
          onClick={() => toggleAgentModel(item.id)}
          disabled={sessionLocked}
          title={[isSelected ? t('modelSelector.deselect') : t('modelSelector.selectConcurrent'), factTitle].filter(Boolean).join('\n')}
        >
          <span className="model-tag-label">{item.label}</span>
          {item.description && (
            <span className="model-tag-description">{item.description}</span>
          )}
          {facts.length > 0 && (
            <span className="model-tag-facts">
              {facts.map(fact => (
                <span key={`${fact.label}:${fact.value}`} className="model-tag-fact">
                  <span className="model-tag-fact-label">{fact.label}</span>
                  <span className="model-tag-fact-value">{fact.value}</span>
                </span>
              ))}
            </span>
          )}
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

  const renderFilterButton = ({ value, label, count: optionCount }, current, onChange) => (
    <button
      key={value}
      type="button"
      className={`model-filter-chip ${current === value ? 'active' : ''}`}
      onClick={() => onChange(value)}
      aria-pressed={current === value}
    >
      <span>{label || value}</span>
      {typeof optionCount === 'number' && <span className="model-filter-chip-count">{optionCount}</span>}
    </button>
  );

  return (
    <div className="model-dropdown">
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
        <div className="model-picker-mask" onMouseDown={() => setOpen(false)}>
          <div className="model-picker-dialog" role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
            <div className="model-picker-header">
              <div className="model-picker-title">
                <span>{t('modelSelector.selectModels')}</span>
                <span className="model-picker-subtitle">
                  {t('modelSelector.resultCount', { count: visibleCount, total: availableModels.length })}
                </span>
              </div>
              <button
                type="button"
                className="model-picker-close"
                onClick={() => setOpen(false)}
                title={t('common.close')}
              >
                <X size={16} />
              </button>
            </div>

            <div className="model-picker-toolbar">
              <div className="model-dropdown-search model-picker-search">
                <Search size={15} />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t('modelSelector.searchPlaceholder')}
                  disabled={sessionLocked}
                />
              </div>
              <div className="model-picker-actions">
                {count > 0 && (
                  <button
                    type="button"
                    className="model-clear-btn"
                    onClick={() => setSelectedAgentModels([])}
                    disabled={sessionLocked}
                  >{t('modelSelector.clearAll')}</button>
                )}
                <button
                  type="button"
                  className="model-clear-btn"
                  onClick={resetFilters}
                  disabled={activeFilterCount === 0}
                >{t('modelSelector.resetFilters')}</button>
              </div>
            </div>

            <div className="model-filter-grid">
              <div className="model-filter-group">
                <span className="model-filter-label">{t('modelSelector.filterProvider')}</span>
                <div className="model-filter-chips">
                  {renderFilterButton({ value: 'all', label: t('modelSelector.all'), count: availableModels.length }, providerFilter, setProviderFilter)}
                  {providerOptions.map(option => renderFilterButton(option, providerFilter, setProviderFilter))}
                </div>
              </div>
              <div className="model-filter-group">
                <span className="model-filter-label">{t('modelSelector.filterContext')}</span>
                <div className="model-filter-chips">
                  {[
                    { value: 'all', label: t('modelSelector.all') },
                    { value: 'known', label: t('modelSelector.contextKnown') },
                    { value: '128k', label: '>=128K' },
                    { value: '200k', label: '>=200K' },
                    { value: '1m', label: '>=1M' },
                    { value: 'unknown', label: t('modelSelector.contextUnknown') },
                  ].map(option => renderFilterButton(option, contextFilter, setContextFilter))}
                </div>
              </div>
              {modalityOptions.length > 0 && (
                <div className="model-filter-group">
                  <span className="model-filter-label">{t('modelSelector.filterModality')}</span>
                  <div className="model-filter-chips">
                    {renderFilterButton({ value: 'all', label: t('modelSelector.all') }, modalityFilter, setModalityFilter)}
                    {modalityOptions.map(option => renderFilterButton(option, modalityFilter, setModalityFilter))}
                  </div>
                </div>
              )}
              {capabilityOptions.length > 0 && (
                <div className="model-filter-group model-filter-group-wide">
                  <span className="model-filter-label">{t('modelSelector.filterCapability')}</span>
                  <div className="model-filter-chips">
                    {renderFilterButton({ value: 'all', label: t('modelSelector.all') }, capabilityFilter, setCapabilityFilter)}
                    {capabilityOptions.map(option => renderFilterButton(option, capabilityFilter, setCapabilityFilter))}
                  </div>
                </div>
              )}
            </div>

            {selectedAgentModels.length > 1 && (
              <div className="strategy-toggle model-picker-strategy">
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

            <div className="model-picker-body">
              {selectedItems.length > 0 && (
                <div className="model-provider-group model-selected-group">
                  <div className="model-provider-heading">
                    {t('modelSelector.selectedCount', { count: selectedItems.length })}
                  </div>
                  <div className="model-provider-tags">
                    {selectedItems.map(renderTag)}
                  </div>
                </div>
              )}
              <div className="model-tags model-picker-results">
                {filteredUnselected.length === 0 && <span className="model-tags-empty">{t('modelSelector.noMatch')}</span>}
                {grouped.map(group => (
                  <div key={group.provider} className="model-provider-group">
                    <div className="model-provider-heading">{group.provider}</div>
                    <div className="model-provider-tags">
                      {group.models.map(renderTag)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Agent 模型选择控件：多选下拉（搜索 + 多选 + 优先级排序 + race/vote 策略）。
// 会话开始后仍保留选择器，用于切换后续轮次使用的模型；
// 运行中由 sessionLocked 禁用，避免误改当前请求。
export function ModelSelector({
  availableModels,
  selectedAgentModels,
  setSelectedAgentModels,
  agentStrategy,
  setAgentStrategy,
  sessionLocked,
}) {
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
