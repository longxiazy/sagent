import { Menu, Settings, Trash2 } from 'lucide-react';

// 已开始会话后的顶部 header：左侧菜单/新建/标题，右侧模式切换/模型选择/标签/清空。
// modeSwitch、modelSelect 由父组件传 slot 进来（同一控件在 hero 和 header 共用）。
export function AppHeader({
  sessionTitle,
  sessionLocked,
  messagesLength,
  sessionStarted,
  mode,
  selectedChatModelLabel,
  modeSwitch,
  modelSelect,
  onToggleSessions,
  onCreateSession,
  onReset,
  onOpenSettings,
}) {
  return (
    <div className="header">
      <div className="header-left">
        <button className="session-toggle-btn" onClick={onToggleSessions} title="会话列表">
          <Menu size={16} />
        </button>
        <button className="header-new-session-btn" onClick={onCreateSession} disabled={sessionLocked} title="新建会话">
          + 新建
        </button>
        <span className="header-session-title">{sessionTitle}</span>
      </div>
      <div className="header-right">
        {modeSwitch}
        {modelSelect}
        {sessionStarted && mode !== 'agent' && (
          <span className="header-model-label">{selectedChatModelLabel}</span>
        )}
        <button className="header-icon-btn" onClick={onOpenSettings} title="设置">
          <Settings size={14} />
        </button>
        <button
          className="header-icon-btn"
          onClick={onReset}
          title="清空"
          disabled={messagesLength === 0 || sessionLocked}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
