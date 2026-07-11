import { useState, useRef, useEffect } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronUp, ExternalLink, HelpCircle, Search, X } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';
import { DialogShell } from './dialogs/DialogShell.jsx';

const MODEL_CATEGORY_DEFS = [
  { id: 'text-chat', labelKey: 'modelSelector.categoryTextChat', descKey: 'modelSelector.categoryTextChatDesc' },
  { id: 'multimodal-understanding', labelKey: 'modelSelector.categoryMultimodal', descKey: 'modelSelector.categoryMultimodalDesc' },
  { id: 'image-generation', labelKey: 'modelSelector.categoryImageGeneration', descKey: 'modelSelector.categoryImageGenerationDesc' },
  { id: 'embedding-retrieval', labelKey: 'modelSelector.categoryEmbedding', descKey: 'modelSelector.categoryEmbeddingDesc' },
  { id: 'rerank-scoring', labelKey: 'modelSelector.categoryRerank', descKey: 'modelSelector.categoryRerankDesc' },
  { id: 'safety-guardrail', labelKey: 'modelSelector.categorySafety', descKey: 'modelSelector.categorySafetyDesc' },
  { id: 'speech-audio', labelKey: 'modelSelector.categorySpeech', descKey: 'modelSelector.categorySpeechDesc' },
  { id: 'bio-chem', labelKey: 'modelSelector.categoryBioChem', descKey: 'modelSelector.categoryBioChemDesc' },
  { id: 'simulation-engineering', labelKey: 'modelSelector.categorySimulation', descKey: 'modelSelector.categorySimulationDesc' },
  { id: 'autonomous-driving', labelKey: 'modelSelector.categoryAutonomous', descKey: 'modelSelector.categoryAutonomousDesc' },
];

const ENCYCLOPEDIA_FIELD_DEFS = [
  { key: 'id', getValue: model => model?.id },
  { key: 'aliases', getValue: model => model?.aliases },
  { key: 'label', getValue: model => model?.label },
  { key: 'publisher', getValue: model => model?.publisher },
  { key: 'description', getValue: model => model?.description },
  { key: 'catalogUrl', getValue: model => model?.catalogUrl, link: true },
  { key: 'supportedGenerationMethods', getValue: model => model?.supportedGenerationMethods || model?.supported_generation_methods },
  { key: 'supportedMessageRoles', getValue: model => model?.supportedMessageRoles || model?.supported_message_roles },
  { key: 'supportedParameters', getValue: model => model?.supportedParameters || model?.supported_parameters },
  { key: 'inputModalities', getValue: model => model?.inputModalities || model?.input_modalities },
  { key: 'outputModalities', getValue: model => model?.outputModalities || model?.output_modalities },
  { key: 'supportedMessageTypes', getValue: model => model?.supportedMessageTypes || model?.supported_message_types },
  { key: 'updated', getValue: model => model?.updated },
  { key: 'contextWindow', getValue: model => model?.contextWindow || model?.context_length || model?.inputTokenLimit, token: true },
];

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

function lowerList(value) {
  return asList(value).map(item => item.toLowerCase());
}

function formatList(value) {
  const items = asList(value);
  if (!items.length) return null;
  return items.join(', ');
}

function formatEncyclopediaValue(value, { token = false } = {}) {
  if (token) return formatTokenLimit(value);
  if (Array.isArray(value)) return formatList(value);
  if (value == null || value === '') return null;
  return String(value);
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
    ...asList(model?.aliases),
    model?.label,
    model?.provider,
    model?.publisher,
    model?.description,
    model?.catalogUrl,
    model?.updated,
    ...modelFacts(model).flatMap(fact => [fact.label, fact.value]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function modelKeywordText(model) {
  return [
    model?.id,
    model?.label,
    model?.provider,
    model?.publisher,
    model?.description,
    model?.catalogUrl,
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

function modelCategoryIds(model) {
  const text = modelKeywordText(model);
  const input = lowerList(model?.inputModalities || model?.input_modalities);
  const output = lowerList(model?.outputModalities || model?.output_modalities);
  const methods = lowerList(model?.supportedGenerationMethods || model?.supported_generation_methods);
  const params = lowerList(model?.supportedParameters || model?.supported_parameters);
  const messageTypes = lowerList(model?.supportedMessageTypes || model?.supported_message_types);
  const combined = uniqueSorted([...input, ...output, ...methods, ...params, ...messageTypes]);
  const has = needle => combined.includes(needle);
  const hasMediaInput = input.some(v => ['image', 'video', 'audio'].includes(v));
  const hasTextInput = input.includes('text') || input.length === 0;
  const hasTextOutput = output.includes('text') || output.length === 0;
  const categories = new Set();

  if (
    (hasTextInput && hasTextOutput && methods.includes('chat.completions'))
    || /\b(chat|conversation|instruct|reasoning|text generation|language model|llm|gpt|llama|gemma|qwen|deepseek|kimi|mistral|nemotron|phi-4)\b/.test(text)
  ) {
    categories.add('text-chat');
  }
  if (
    (hasMediaInput && output.includes('text'))
    || methods.some(v => ['image', 'video', 'audio'].includes(v))
    || /vision[-\s]?language|multimodal|understands? (text\/img|images?|videos?)|image understanding|video understanding/.test(text)
  ) {
    categories.add('multimodal-understanding');
  }
  if (
    output.includes('image')
    || /image (generation|editing)|generat(?:e|es|ion).*images?|flux|kontext|qwen-image-edit/.test(text)
  ) {
    categories.add('image-generation');
  }
  if (
    output.some(v => /float|embedding/.test(v))
    || /embedding|retrieval|dense vector|sparse retrieval|embedqa|embedcode/.test(text)
  ) {
    categories.add('embedding-retrieval');
  }
  if (/rerank|re-rank|ranking|logits|scores?/.test(text) || output.some(v => /logits|scores?/.test(v))) {
    categories.add('rerank-scoring');
  }
  if (/guard|safety|jailbreak|pii|content[-\s]?safety|topic control|nemoguard/.test(text)) {
    categories.add('safety-guardrail');
  }
  if (has('audio') || /speech|audio|asr|tts|voice|noise removal|lipsync|lip sync|canary|conformer/.test(text)) {
    categories.add('speech-audio');
  }
  if (/alphafold|boltz|diffdock|esm|evo2|genmol|protein|molecule|genomic|biology|chemical|chemistry/.test(text)) {
    categories.add('bio-chem');
  }
  if (/cfd|fluid dynamics|weather|climate|route optimization|simulation|physics-aware|fourcast|cuopt|fluent|fidelity/.test(text)) {
    categories.add('simulation-engineering');
  }
  if (
    combined.some(v => /vehicle|camera|extrinsics|intrinsics|ego|trajectory|bounding-box/.test(v))
    || /autonomous driving|bird'?s-eye-view|bevformer|streampetr|3d perception|trajectory/.test(text)
  ) {
    categories.add('autonomous-driving');
  }

  if (categories.has('image-generation')) {
    categories.delete('multimodal-understanding');
    categories.delete('text-chat');
  }
  if (
    categories.has('embedding-retrieval')
    || categories.has('rerank-scoring')
    || categories.has('safety-guardrail')
    || categories.has('speech-audio')
    || categories.has('bio-chem')
    || categories.has('simulation-engineering')
    || categories.has('autonomous-driving')
  ) {
    categories.delete('text-chat');
  }
  return [...categories];
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
  if (filters.categories.length > 0) {
    const categoryIds = modelCategoryIds(model);
    if (!filters.categories.some(category => categoryIds.includes(category))) return false;
  }

  const context = modelContextTokens(model);
  if (filters.context === 'known' && !context) return false;
  if (filters.context === 'unknown' && context) return false;
  if (filters.context === '128k' && (!context || context < 128_000)) return false;
  if (filters.context === '200k' && (!context || context < 200_000)) return false;
  if (filters.context === '1m' && (!context || context < 1_000_000)) return false;
  return true;
}

// 模型选择弹框的通用交互：打开后聚焦搜索、ESC 关闭。
function useModelPickerDialog() {
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const coarsePointer = typeof window !== 'undefined'
      && window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
    if (!coarsePointer) {
      inputRef.current?.focus();
    }
    const onKeyDown = e => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return { open, setOpen, inputRef };
}

// 通用模型选择弹框：Agent 使用多选 + 排序 + 策略；压缩/索引使用同款单选。
function ModelPickerDropdown({
  availableModels,
  value,
  onChange,
  multiple = false,
  agentStrategy,
  setAgentStrategy,
  disabled = false,
  title,
  placeholder,
  dialogTitle,
  clearable = true,
}) {
  const t = useT();
  const { open, setOpen, inputRef } = useModelPickerDialog();
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [modalityFilter, setModalityFilter] = useState('all');
  const [capabilityFilter, setCapabilityFilter] = useState('all');
  const [contextFilter, setContextFilter] = useState('all');
  const [categoryFilters, setCategoryFilters] = useState([]);
  const [encyclopediaOpen, setEncyclopediaOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [expandedEncyclopediaModels, setExpandedEncyclopediaModels] = useState([]);

  const openPanel = () => {
    setQuery('');
    setEncyclopediaOpen(false);
    setFiltersExpanded(false);
    setOpen(o => !o);
  };

  const resetFilters = () => {
    setQuery('');
    setProviderFilter('all');
    setModalityFilter('all');
    setCapabilityFilter('all');
    setContextFilter('all');
    setCategoryFilters([]);
    setExpandedEncyclopediaModels([]);
  };

  const selectedModelIds = multiple
    ? (Array.isArray(value) ? value : [])
    : (value ? [value] : []);

  const setSelectedModelIds = next => {
    if (multiple) {
      onChange?.(next);
      return;
    }
    onChange?.(next[0] || '');
  };

  const toggleModel = id => {
    if (!multiple) {
      setSelectedModelIds([id]);
      setOpen(false);
      return;
    }
    setSelectedModelIds(selectedModelIds.includes(id)
      ? selectedModelIds.filter(m => m !== id)
      : [...selectedModelIds, id]);
  };

  const moveModel = (id, dir) => {
    const idx = selectedModelIds.indexOf(id);
    if (idx < 0) return;
    const next = [...selectedModelIds];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setSelectedModelIds(next);
  };

  // 已选模型始终置顶且不受搜索影响，避免选中后被过滤掉看不到。
  const selectedSet = new Set(selectedModelIds);
  const selectedItems = selectedModelIds
    .map(id => availableModels.find(m => m.id === id))
    .filter(Boolean);
  const unselectedItems = availableModels.filter(m => !selectedSet.has(m.id));
  const filters = {
    provider: providerFilter,
    modality: modalityFilter,
    capability: capabilityFilter,
    context: contextFilter,
    categories: categoryFilters,
  };
  const filteredUnselected = filterModels(unselectedItems, query)
    .filter(model => matchesComplexFilters(model, filters));
  const filteredCatalogModels = filterModels(availableModels, query)
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
  const categoryCounts = countOptions(availableModels, modelCategoryIds)
    .reduce((acc, option) => ({ ...acc, [option.value]: option.count }), {});
  const encyclopediaGroups = groupByProvider(filteredCatalogModels);
  const visibleCount = selectedItems.length + filteredUnselected.length;
  const activeFilterCount = [
    providerFilter !== 'all',
    modalityFilter !== 'all',
    capabilityFilter !== 'all',
    contextFilter !== 'all',
    categoryFilters.length > 0,
    Boolean(query.trim()),
  ].filter(Boolean).length;

  const count = selectedModelIds.length;
  const triggerLabel = count === 1
    ? (selectedItems[0]?.label || selectedModelIds[0])
    : count > 1
      ? t('modelSelector.selectedCount', { count })
      : (placeholder || t(multiple ? 'modelSelector.selectModels' : 'modelSelector.selectModel'));

  const renderOption = item => {
    const isSelected = selectedSet.has(item.id);
    const orderIdx = selectedModelIds.indexOf(item.id);
    const secondary = item.description || (item.label && item.label !== item.id ? item.id : '');
    return (
      <span key={item.id} className={`model-option-wrapper ${isSelected ? 'selected' : ''}`}>
        <button
          className={`model-option ${isSelected ? 'selected' : ''}`}
          onClick={() => toggleModel(item.id)}
          disabled={disabled}
          title={[isSelected ? t('modelSelector.deselect') : t(multiple ? 'modelSelector.selectConcurrent' : 'modelSelector.selectModel'), item.id].filter(Boolean).join('\n')}
        >
          <span className="model-option-check" aria-hidden="true">
            {isSelected && <Check size={14} />}
          </span>
          <span className="model-option-text">
            <span className="model-option-name">{item.label || item.id}</span>
            {secondary && <span className="model-option-description">{secondary}</span>}
          </span>
        </button>
        {multiple && isSelected && selectedModelIds.length > 1 && (
          <span className="model-option-order">
            <button className="order-arrow" onClick={() => moveModel(item.id, -1)} disabled={orderIdx <= 0 || disabled} title={t('modelSelector.raisePriority')}><ChevronUp size={10} /></button>
            <span className="order-number">{orderIdx + 1}</span>
            <button className="order-arrow" onClick={() => moveModel(item.id, 1)} disabled={orderIdx >= selectedModelIds.length - 1 || disabled} title={t('modelSelector.lowerPriority')}><ChevronDown size={10} /></button>
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
      onClick={() => {
        onChange(value);
        if (current !== value) {
          setExpandedEncyclopediaModels([]);
        }
      }}
      aria-pressed={current === value}
    >
      <span>{label || value}</span>
      {typeof optionCount === 'number' && <span className="model-filter-chip-count">{optionCount}</span>}
    </button>
  );

  const toggleCategoryFilter = id => {
    setExpandedEncyclopediaModels([]);
    setCategoryFilters(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]);
  };

  const categoryLabel = id => {
    const def = MODEL_CATEGORY_DEFS.find(item => item.id === id);
    return def ? t(def.labelKey) : id;
  };

  const renderCategoryCheckbox = category => (
    <label key={category.id} className={`model-category-checkbox ${categoryFilters.includes(category.id) ? 'checked' : ''}`} title={t(category.descKey)}>
      <input
        type="checkbox"
        checked={categoryFilters.includes(category.id)}
        onChange={() => toggleCategoryFilter(category.id)}
      />
      <span className="model-category-checkbox-box" aria-hidden="true">
        {categoryFilters.includes(category.id) && <Check size={12} />}
      </span>
      <span className="model-category-checkbox-text">{t(category.labelKey)}</span>
      <span className="model-category-checkbox-count">{categoryCounts[category.id] || 0}</span>
    </label>
  );

  const renderModelBadges = model => {
    const categories = modelCategoryIds(model);
    return (
      <span className="model-encyclopedia-badges">
        {categories.slice(0, 3).map(category => (
          <span key={category} className="model-encyclopedia-badge">{categoryLabel(category)}</span>
        ))}
      </span>
    );
  };

  const renderEncyclopediaField = (model, field) => {
    const rawValue = field.getValue(model);
    const value = formatEncyclopediaValue(rawValue, field);
    if (!value) return null;
    return (
      <div key={field.key} className="model-encyclopedia-field">
        <span className="model-encyclopedia-field-label">{field.key}</span>
        {field.link && value ? (
          <a className="model-encyclopedia-field-value" href={value} target="_blank" rel="noreferrer">{value}</a>
        ) : (
          <span className="model-encyclopedia-field-value">{value}</span>
        )}
      </div>
    );
  };

  const toggleEncyclopediaModel = id => {
    setExpandedEncyclopediaModels(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]);
  };

  const renderEncyclopediaSummaryFacts = model => {
    const facts = [
      model?.publisher,
      formatTokenLimit(model?.contextWindow || model?.context_length || model?.inputTokenLimit),
      formatList(model?.inputModalities || model?.input_modalities),
      formatList(model?.supportedGenerationMethods || model?.supported_generation_methods),
    ].filter(Boolean);
    if (!facts.length) return null;
    return (
      <span className="model-encyclopedia-summary-facts">
        {facts.slice(0, 4).map(fact => <span key={fact}>{fact}</span>)}
      </span>
    );
  };

  const renderEncyclopediaItem = model => {
    const expanded = expandedEncyclopediaModels.includes(model.id);
    const hasFields = ENCYCLOPEDIA_FIELD_DEFS.some(field => formatEncyclopediaValue(field.getValue(model), field));
    const isSelected = selectedSet.has(model.id);
    return (
      <article key={model.id} className={`model-encyclopedia-item ${expanded ? 'expanded' : ''}`}>
        <div className="model-encyclopedia-row">
          <button
            type="button"
            className="model-encyclopedia-summary"
            onClick={() => toggleEncyclopediaModel(model.id)}
            aria-expanded={expanded}
          >
            <span className="model-encyclopedia-chevron" aria-hidden="true">
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <span className="model-encyclopedia-item-main">
              <span className="model-encyclopedia-name">{model.label || model.id}</span>
              <span className="model-encyclopedia-description">{model.description || model.id}</span>
              <span className="model-encyclopedia-meta">
                {renderModelBadges(model)}
                {renderEncyclopediaSummaryFacts(model)}
              </span>
            </span>
          </button>
          <div className="model-encyclopedia-item-side">
            <button
              type="button"
              className={`model-encyclopedia-select ${isSelected ? 'selected' : ''}`}
              onClick={() => toggleModel(model.id)}
              disabled={disabled || (!multiple && isSelected)}
              title={isSelected ? t('modelSelector.selected') : t(multiple ? 'modelSelector.selectConcurrent' : 'modelSelector.selectModel')}
            >
              {isSelected ? t('modelSelector.selected') : t('modelSelector.selectModel')}
            </button>
            <code>{model.id}</code>
            {model.catalogUrl && (
              <a href={model.catalogUrl} target="_blank" rel="noreferrer" title={t('modelSelector.catalogLink')}>
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        </div>
        {expanded && hasFields && (
          <div className="model-encyclopedia-fields">
            {ENCYCLOPEDIA_FIELD_DEFS.map(field => renderEncyclopediaField(model, field))}
          </div>
        )}
      </article>
    );
  };

  const renderEncyclopediaGroup = group => (
    <section key={group.provider} className="model-encyclopedia-tree-group">
      <div className="model-encyclopedia-tree-heading">
        <span className="model-encyclopedia-tree-dot" aria-hidden="true" />
        <span className="model-encyclopedia-tree-provider">{group.provider}</span>
        <span className="model-encyclopedia-tree-count">{group.models.length}</span>
      </div>
      <div className="model-encyclopedia-tree-children">
        {group.models.map(renderEncyclopediaItem)}
      </div>
    </section>
  );

  const renderSearchSelectedChip = item => (
    <span key={item.id} className="model-search-selected-chip">
      <span>{item.label || item.id}</span>
      {multiple && clearable && (
        <button
          type="button"
          onClick={() => setSelectedModelIds(selectedModelIds.filter(id => id !== item.id))}
          disabled={disabled}
          title={t('modelSelector.deselect')}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );

  return (
    <div className={`model-dropdown ${multiple ? 'multi' : 'single'}`}>
      <button
        type="button"
        className={`model-dropdown-trigger ${count > 0 ? 'has-selection' : ''}`}
        onClick={openPanel}
        disabled={disabled}
        title={title || t('modelSelector.switchModel')}
      >
        <span className="model-dropdown-main">
          <span className="model-dropdown-label">{triggerLabel}</span>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <DialogShell
          title={dialogTitle || t(multiple ? 'modelSelector.selectModels' : 'modelSelector.selectModel')}
          subtitle={t('modelSelector.resultCount', { count: visibleCount, total: availableModels.length })}
          onClose={() => setOpen(false)}
          headerActions={(
            <button
              type="button"
              className={`model-picker-help ${encyclopediaOpen ? 'active' : ''}`}
              onClick={() => {
                setEncyclopediaOpen(current => {
                  const next = !current;
                  setFiltersExpanded(false);
                  if (next) setExpandedEncyclopediaModels([]);
                  return next;
                });
              }}
              title={t('modelSelector.openEncyclopedia')}
              aria-pressed={encyclopediaOpen}
            >
              <HelpCircle size={16} />
            </button>
          )}
        >

            {!encyclopediaOpen && (
              <>
                <div className="model-picker-toolbar">
                  <div className="model-dropdown-search model-picker-search">
                    <Search size={15} />
                    {selectedItems.length > 0 && (
                      <span className="model-search-selected-tags" aria-label={t('modelSelector.selectedCount', { count: selectedItems.length })}>
                        {selectedItems.map(renderSearchSelectedChip)}
                      </span>
                    )}
                    <input
                      ref={inputRef}
                      type="text"
                      value={query}
                      onKeyDown={e => {
                        if (
                          multiple
                          && clearable
                          && !disabled
                          && query.length === 0
                          && selectedModelIds.length > 0
                          && (e.key === 'Backspace' || e.key === 'Delete')
                        ) {
                          e.preventDefault();
                          setSelectedModelIds(selectedModelIds.slice(0, -1));
                        }
                      }}
                      onChange={e => {
                        setQuery(e.target.value);
                        setExpandedEncyclopediaModels([]);
                      }}
                      placeholder={t('modelSelector.searchPlaceholder')}
                      disabled={disabled}
                    />
                  </div>
                  <div className="model-picker-actions">
                    {multiple && clearable && count > 0 && (
                      <button
                        type="button"
                        className="model-clear-btn"
                        onClick={() => setSelectedModelIds([])}
                        disabled={disabled}
                      >{t('modelSelector.clearAll')}</button>
                    )}
                    <button
                      type="button"
                      className="model-clear-btn"
                      onClick={resetFilters}
                      disabled={activeFilterCount === 0}
                    >{t('modelSelector.resetFilters')}</button>
                    <button
                      type="button"
                      className={`model-filter-toggle ${filtersExpanded ? 'active' : ''}`}
                      onClick={() => setFiltersExpanded(open => !open)}
                      aria-expanded={filtersExpanded}
                    >
                      {activeFilterCount > 0
                        ? t('modelSelector.filterToggleWithCount', { count: activeFilterCount })
                        : t('modelSelector.filterToggle')}
                    </button>
                  </div>
                </div>

                <div className={`model-filter-grid ${filtersExpanded ? 'open' : ''}`}>
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
                  <div className="model-filter-group model-filter-group-wide model-category-filter-group">
                    <span className="model-filter-label">{t('modelSelector.filterTaskType')}</span>
                    <div className="model-category-checkboxes">
                      {MODEL_CATEGORY_DEFS.map(renderCategoryCheckbox)}
                    </div>
                  </div>
                </div>
              </>
            )}

            {encyclopediaOpen ? (
              <div className="model-encyclopedia">
                <div className="model-encyclopedia-head">
                  <div>
                    <h2>{t('modelSelector.encyclopediaTitle')}</h2>
                    <p>{t('modelSelector.encyclopediaIntro')}</p>
                  </div>
                  <span className="model-encyclopedia-range">
                    {t('modelSelector.encyclopediaCount', { count: filteredCatalogModels.length })}
                  </span>
                </div>
                <div className="model-encyclopedia-guide">
                  {MODEL_CATEGORY_DEFS.map(category => (
                    <div key={category.id} className="model-encyclopedia-guide-item" title={`${t(category.labelKey)}: ${t(category.descKey)}`}>
                      <strong>{t(category.labelKey)}</strong>
                      <span>{t(category.descKey)}</span>
                    </div>
                  ))}
                </div>
                <div className="model-encyclopedia-list">
                  {encyclopediaGroups.length === 0
                    ? <span className="model-options-empty">{t('modelSelector.noMatch')}</span>
                    : encyclopediaGroups.map(renderEncyclopediaGroup)}
                </div>
              </div>
            ) : (
              <>
            {multiple && selectedModelIds.length > 1 && (
              <div className="strategy-toggle model-picker-strategy">
                <button
                  className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
                  onClick={() => setAgentStrategy('race')}
                  disabled={disabled}
                  title={t('modelSelector.raceTitle')}
                >{t('modelSelector.race')}</button>
                <button
                  className={`strategy-btn ${agentStrategy === 'vote' ? 'active' : ''}`}
                  onClick={() => setAgentStrategy('vote')}
                  disabled={disabled}
                  title={t('modelSelector.voteTitle')}
                >{t('modelSelector.vote')}</button>
              </div>
            )}

            <div className="model-picker-body">
              {selectedItems.length > 0 && (
                <div className="model-provider-group model-selected-group">
                  <div className="model-provider-heading">
                    {multiple ? t('modelSelector.selectedCount', { count: selectedItems.length }) : t('modelSelector.currentModel')}
                  </div>
                  <div className="model-provider-options">
                    {selectedItems.map(renderOption)}
                  </div>
                </div>
              )}
              <div className="model-options model-picker-results">
                {filteredUnselected.length === 0 && <span className="model-options-empty">{t('modelSelector.noMatch')}</span>}
                {grouped.map(group => (
                  <div key={group.provider} className="model-provider-group">
                    <div className="model-provider-heading">{group.provider}</div>
                    <div className="model-provider-options">
                      {group.models.map(renderOption)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
              </>
            )}
        </DialogShell>
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
      <ModelPickerDropdown
        availableModels={availableModels}
        value={selectedAgentModels}
        onChange={setSelectedAgentModels}
        multiple
        agentStrategy={agentStrategy}
        setAgentStrategy={setAgentStrategy}
        disabled={sessionLocked}
      />
    </div>
  );
}

export function SingleModelSelector({
  availableModels,
  value,
  onChange,
  disabled = false,
  title,
  placeholder,
  dialogTitle,
  className = '',
}) {
  return (
    <div className={`model-select-row single-model-select-row ${className}`}>
      <ModelPickerDropdown
        availableModels={availableModels}
        value={value}
        onChange={onChange}
        disabled={disabled}
        title={title}
        placeholder={placeholder}
        dialogTitle={dialogTitle}
        clearable={false}
      />
    </div>
  );
}
