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
// 工具栏控件（模型、附件、隐私模式、发送）由父组件传 slot 进来，
// hero 和 workspace 布局共用同一组状态与元素定义。
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
  const { modelSelect, sendButton, attachButton, privateModeToggle } = toolbarSlots;
  const t = useT();
  const [suggestionsHidden, setSuggestionsHidden] = useState(readSuggestionsHidden);

  const hideSuggestions = () => {
    setSuggestionsHidden(true);
    try { localStorage.setItem(SUGGESTIONS_HIDDEN_KEY, '1'); } catch { /* localStorage 不可用时忽略 */ }
  };
  const showSuggestions = () => {
    setSuggestionsHidden(false);
    try { localStorage.removeItem(SUGGESTIONS_HIDDEN_KEY); } catch { /* localStorage 不可用时忽略 */ }
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
          privateModeToggle={privateModeToggle}
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
