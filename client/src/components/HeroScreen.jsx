import { useState } from 'react';
import { Menu, Settings, Lightbulb } from 'lucide-react';
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

// 首屏：brand + 输入卡 + 推荐列表。
// 工具栏控件（ModeSwitch / ModelSelector / MemoryToggle / SendButton / AttachButton）
// 由父组件传 slot 进来——它们在 hero 和 layout header 两处会复用同一个实例。
export function HeroScreen({
  mode,
  input,
  setInput,
  onKeyDown,
  textareaRef,
  sessionLocked,
  toolbarSlots,
  attachmentBar,
  suggestions,
  categories,
  activeCategoryId,
  onSelectCategory,
  onShuffle,
  onPickSuggestion,
  onSubmitSuggestion,
  onToggleSessions,
  onOpenSettings,
}) {
  const { modeSwitch, modelSelect, memoryToggle, sendButton, attachButton } = toolbarSlots;
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
    <div className="hero-wrap">
      <div className="hero">
        <button className="session-toggle-btn hero-menu" onClick={onToggleSessions} title={t('header.sessionList')}>
          <Menu size={16} />
        </button>
        <button className="session-toggle-btn hero-settings" onClick={onOpenSettings} title={t('header.settings')}>
          <Settings size={16} />
        </button>

        <div className="hero-brand">
          <h1 className="hero-title">sagent</h1>
          <p className="hero-subtitle">{t('hero.subtitle')}</p>
        </div>

        <div className="hero-input-card">
          {attachmentBar}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'agent' ? t('input.agentPlaceholder') : t('input.chatPlaceholder')}
            rows={2}
            disabled={sessionLocked}
          />
          <div className="hero-toolbar">
            {modeSwitch}
            {modelSelect}
            {memoryToggle}
            {attachButton}
            {sendButton}
          </div>
        </div>

        {suggestionsHidden ? (
          <button className="suggestions-show" onClick={showSuggestions} title={t('suggestions.show')}>
            <Lightbulb size={12} /> {t('suggestions.show')}
          </button>
        ) : (
          <SuggestionsList
            mode={mode}
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
