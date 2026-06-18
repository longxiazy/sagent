import { useT } from '../i18n/I18nProvider.jsx';

// 模式切换：chat / agent。只在 sessionStarted=false 时渲染。
export function ModeSwitch({ mode, setMode, sessionLocked, sessionStarted }) {
  const t = useT();
  if (sessionStarted) return null;
  return (
    <div className="mode-switch" aria-label={t('mode.ariaLabel')}>
      <button
        className={`mode-btn ${mode === 'chat' ? 'active' : ''}`}
        onClick={() => setMode('chat')}
        disabled={sessionLocked}
      >{t('mode.chat')}</button>
      <button
        className={`mode-btn ${mode === 'agent' ? 'active' : ''}`}
        onClick={() => setMode('agent')}
        disabled={sessionLocked}
      >Agent</button>
    </div>
  );
}
