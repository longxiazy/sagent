import { createSession, normalizeChatState, touchSession } from './useChatSessions.js';
import { tStatic } from '../i18n/locale.js';

// 会话生命周期相关的 handler 集合：新建/切换/删除/清空/重置。
// 这些 handler 各自独立、但都依赖同一组 props 上下文，所以打包成一个 hook 提供。
export function useSessionHandlers({
  sessions,
  activeSession,
  sessionLocked,
  setChatState,
  setInput,
  setShowReset,
  setShowSessions,
  updateSession,
  textareaRef,
  activeProjectId = null,
}) {
  const handleSelectSession = sessionId => {
    if (sessionLocked || sessionId === activeSession.id) {
      return;
    }

    setChatState(prev =>
      normalizeChatState({
        ...prev,
        activeSessionId: sessionId,
      })
    );
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleCreateSession = () => {
    if (sessionLocked) {
      return;
    }

    // 复用当前项目下的空白会话；没有则新建并归属当前项目。
    const blankSession = sessions.find(
      session => session.messages.length === 0 && (session.projectId ?? null) === (activeProjectId ?? null)
    );
    if (blankSession) {
      handleSelectSession(blankSession.id);
      if (window.innerWidth < 768) setShowSessions(false);
      return;
    }

    const nextSession = createSession({ projectId: activeProjectId });

    setChatState(prev =>
      normalizeChatState({
        sessions: [nextSession, ...prev.sessions],
        activeSessionId: nextSession.id,
      })
    );
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleDeleteSession = sessionId => {
    if (sessionLocked || !window.confirm(tStatic('sessionOps.confirmDelete'))) {
      return;
    }

    setChatState(prev => {
      const nextSessions = prev.sessions.filter(session => session.id !== sessionId);
      const nextActiveSessionId =
        sessionId === prev.activeSessionId
          ? nextSessions[0]?.id || createSession({ projectId: activeProjectId }).id
          : prev.activeSessionId;

      return normalizeChatState({
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
      });
    });
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleClearAllSessions = () => {
    if (sessionLocked || !window.confirm(tStatic('sessionOps.confirmClearAll'))) {
      return;
    }
    setChatState(normalizeChatState({ sessions: [], activeSessionId: null }));
    setInput('');
    setShowReset(false);
    setShowSessions(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleReset = () => {
    updateSession(activeSession.id, session => touchSession(session, { messages: [] }));
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  return {
    handleCreateSession,
    handleSelectSession,
    handleDeleteSession,
    handleClearAllSessions,
    handleReset,
  };
}
