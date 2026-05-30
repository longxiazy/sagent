import { createSession, normalizeChatState, touchSession } from './useChatSessions.js';

// 会话生命周期相关的 handler 集合：新建/切换/删除/清空/重置/换模型。
// 多 run 语义:
//   - 切换/新建会话不受 agent 运行影响(核心诉求:agent 跑着时能切走、能在新会话发任务);
//     但普通聊天流式(chatStreaming)中切换会打断流,仍禁止。
//   - 删除/清空对"正在跑 agent"的会话做保护,避免误删运行中的任务。
export function useSessionHandlers({
  sessions,
  activeSession,
  chatStreaming,
  runningSessionIds,
  setChatState,
  setInput,
  setShowReset,
  setShowSessions,
  updateSession,
  textareaRef,
}) {
  const running = runningSessionIds || new Set();

  const handleSelectSession = sessionId => {
    if (chatStreaming || sessionId === activeSession.id) {
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
    if (chatStreaming) {
      return;
    }

    const blankSession = sessions.find(session => session.messages.length === 0);
    if (blankSession) {
      handleSelectSession(blankSession.id);
      if (window.innerWidth < 768) setShowSessions(false);
      return;
    }

    const nextSession = createSession();

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
    if (running.has(sessionId)) {
      window.alert('该会话有 Agent 任务正在运行,请先停止或等待完成。');
      return;
    }
    if (!window.confirm('删除这个会话？此操作不可撤销。')) {
      return;
    }

    setChatState(prev => {
      const nextSessions = prev.sessions.filter(session => session.id !== sessionId);
      const nextActiveSessionId =
        sessionId === prev.activeSessionId ? nextSessions[0]?.id || createSession().id : prev.activeSessionId;

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
    if (running.size > 0) {
      window.alert('有 Agent 任务正在运行,无法清空全部会话。');
      return;
    }
    if (!window.confirm('清空所有会话？此操作不可撤销。')) {
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

  const setChatModel = nextModel => {
    updateSession(activeSession.id, session => touchSession(session, { model: nextModel }));
  };

  return {
    handleCreateSession,
    handleSelectSession,
    handleDeleteSession,
    handleClearAllSessions,
    handleReset,
    setChatModel,
  };
}
