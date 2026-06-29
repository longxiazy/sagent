import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { AgentComposer } from './AgentComposer.jsx';
import { SuggestionsList } from './SuggestionsList.jsx';
import { useT } from '../i18n/I18nProvider.jsx';

// 首页推荐面板的隐藏状态持久化到 localStorage(纯前端 UI 偏好,刷新/下次打开保持)。
const SUGGESTIONS_HIDDEN_KEY = 'sagent.suggestionsHidden';
function readSuggestionsHidden() {
  try {
    return localStorage.getItem(SUGGESTIONS_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

// 首屏：输入卡 + 推荐列表。
// 会话/设置入口由父组件渲染在 main-area 右上角(.hero-corner-actions),不在 hero 容器内。
// 工具栏控件（ModelSelector / SendButton / AttachButton）
// 由父组件传 slot 进来——它们在 hero 和 layout header 两处会复用同一个实例。
export function HeroScreen({
  input,
  setInput,
  onKeyDown,
  textareaRef,
  sessionLocked,
  toolbarSlots,
  attachmentBar,
  contextMeter,
  suggestions,
  categories,
  activeCategoryId,
  onSelectCategory,
  onShuffle,
  onPickSuggestion,
  onSubmitSuggestion,
}) {
  const { modelSelect, sendButton, attachButton } = toolbarSlots;
  const t = useT();
  const [suggestionsHidden, setSuggestionsHidden] = useState(readSuggestionsHidden);

  const hideSuggestions = () => {
    setSuggestionsHidden(true);
    try { localStorage.setItem(SUGGESTIONS_HIDDEN_KEY, '1'); } catch { /* 隐私模式下忽略写入失败 */ }
  };
  const showSuggestions = () => {
    setSuggestionsHidden(false);
    try { localStorage.removeItem(SUGGESTIONS_HIDDEN_KEY); } catch { /* 隐私模式下忽略写入失败 */ }
  };

  return (
    <div className={`hero-wrap${suggestionsHidden ? ' hero-wrap--centered' : ''}`}>
      <div className="hero">
        <div className="hero-brand" aria-label="sagent">
          <img className="hero-logo" src="/favicon.svg?v=3" alt="" aria-hidden="true" />
          <span className="hero-brand-name">sagent</span>
        </div>

        <AgentComposer
          variant="hero"
          value={input}
          setValue={setInput}
          textareaRef={textareaRef}
          onKeyDown={onKeyDown}
          placeholder={t('input.agentPlaceholder')}
          rows={2}
          disabled={sessionLocked}
          modelSelect={modelSelect}
          attachButton={attachButton}
          sendButton={sendButton}
          attachmentBar={attachmentBar}
          contextMeter={contextMeter}
        />

        {suggestionsHidden ? (
          <button className="suggestions-show" onClick={showSuggestions} title={t('suggestions.show')}>
            <Lightbulb size={12} /> {t('suggestions.show')}
          </button>
        ) : (
          <SuggestionsList
            mode="agent"
            suggestions={suggestions}
            categories={categories}
            activeCategoryId={activeCategoryId}
            onSelectCategory={onSelectCategory}
            sessionLocked={sessionLocked}
            onShuffle={onShuffle}
            onPick={onPickSuggestion}
            onSubmit={onSubmitSuggestion}
            onHide={hideSuggestions}
          />
        )}
      </div>
    </div>
  );
}
