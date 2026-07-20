import { createSession, normalizeChatState, touchSession } from './useChatSessions.js';
import { tStatic } from '../i18n/locale.js';

// 会话生命周期相关的 handler 集合：新建/切换/删除/重置。
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
      session => !session.archivedAt
        && session.messages.length === 0
        && (session.projectId ?? null) === (activeProjectId ?? null)
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

  const handleArchiveSession = sessionId => {
    if (sessionLocked) {
      return;
    }

    setChatState(prev => {
      const archivedAt = Date.now();
      // 同时 bump updatedAt：归档也是一次修改,让后端单条同步的 diff 能识别到它。
      const nextSessions = prev.sessions.map(session => (
        session.id === sessionId ? { ...session, archivedAt, updatedAt: archivedAt } : session
      ));
      if (sessionId !== prev.activeSessionId) {
        return normalizeChatState({ sessions: nextSessions, activeSessionId: prev.activeSessionId });
      }
      const nextProjectSession = nextSessions.find(
        session => !session.archivedAt && (session.projectId ?? null) === (activeProjectId ?? null)
      );
      if (nextProjectSession) {
        return normalizeChatState({ sessions: nextSessions, activeSessionId: nextProjectSession.id });
      }
      const blank = createSession({ projectId: activeProjectId });

      return normalizeChatState({
        sessions: [blank, ...nextSessions],
        activeSessionId: blank.id,
      });
    });
    setInput('');
    setShowReset(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleRestoreSession = sessionId => {
    if (sessionLocked) return;
    setChatState(prev => normalizeChatState({
      ...prev,
      sessions: prev.sessions.map(session => (
        session.id === sessionId ? { ...session, archivedAt: null, updatedAt: Date.now() } : session
      )),
    }));
  };

  const handleDeleteArchivedSession = sessionId => {
    if (sessionLocked || !window.confirm(tStatic('sessionOps.confirmDeleteArchived'))) return;
    setChatState(prev => normalizeChatState({
      ...prev,
      sessions: prev.sessions.filter(session => session.id !== sessionId),
    }));
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
    handleArchiveSession,
    handleRestoreSession,
    handleDeleteArchivedSession,
    handleReset,
  };
}
