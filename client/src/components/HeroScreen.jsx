import { Menu, Settings } from 'lucide-react';
import { SuggestionsList } from './SuggestionsList.jsx';
import { useT } from '../i18n/I18nProvider.jsx';

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
        />
      </div>
    </div>
  );
}
