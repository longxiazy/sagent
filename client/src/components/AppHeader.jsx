import { Menu, Moon, Settings, Sun, Trash2 } from 'lucide-react';
import { useTheme } from '../theme/ThemeProvider.jsx';
import { useT } from '../i18n/I18nProvider.jsx';

// 已开始会话后的顶部 header：左侧菜单/新建/标题，右侧主题/设置/清空。
// 模型选择器不在这里——它和附件、隐私等一起放在输入框工具栏，与首页保持一致。
export function AppHeader({
  sessionTitle,
  sessionLocked,
  messagesLength,
  agentActionsHostRef,
  onToggleSessions,
  onCreateSession,
  onReset,
  onOpenSettings,
}) {
  const t = useT();
  const { resolvedTheme, toggleTheme } = useTheme();
  return (
    <div className="header">
      <div className="header-left">
        <button className="session-toggle-btn" onClick={onToggleSessions} title={t('header.sessionList')}>
          <Menu size={16} />
        </button>
        <button className="header-new-session-btn" onClick={onCreateSession} disabled={sessionLocked} title={t('header.newSessionTitle')}>
          {t('header.newSession')}
        </button>
        <span className="header-session-title">{sessionTitle}</span>
      </div>
      <div className="header-right">
        <div className="header-agent-actions" ref={agentActionsHostRef} />
        <button className="header-icon-btn" onClick={toggleTheme} title={t('appearance.toggleTheme')}>
          {resolvedTheme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button className="header-icon-btn" onClick={onOpenSettings} title={t('header.settings')}>
          <Settings size={14} />
        </button>
        <button
          className="header-icon-btn"
          onClick={onReset}
          title={t('header.clear')}
          disabled={messagesLength === 0 || sessionLocked}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
