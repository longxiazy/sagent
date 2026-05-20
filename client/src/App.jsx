import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu, Trash2, Square, Brain, ChevronDown, ChevronUp,
  Send, RotateCcw,
} from 'lucide-react';
import './App.css';
import { fetchAgentTrace, submitAgentQuestion } from './api/streams.js';
import { ensureServiceWorker, notificationPermission, notificationsSupported, requestNotificationPermission } from './notifications.js';
import { AgentPane } from './components/AgentPane.jsx';
import { ChatPane } from './components/ChatPane.jsx';
import { SessionSidebar } from './components/SessionSidebar.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { ResizeDivider } from './components/ResizeDivider.jsx';
import { MessageContent } from './components/MessageContent.jsx';
import { CopyButton } from './components/CopyButton.jsx';
import { ResetDialog } from './components/dialogs/ResetDialog.jsx';
import { ApprovalDialog } from './components/dialogs/ApprovalDialog.jsx';
import { QuestionDialog } from './components/dialogs/QuestionDialog.jsx';
import { SessionList } from './components/session/SessionList.jsx';
import { AgentPanel } from './components/agent/AgentPanel.jsx';
import { useAgentRun } from './hooks/useAgentRun.js';
import { createSession, getSessionTitle, normalizeChatState, touchSession, useChatSessions } from './hooks/useChatSessions.js';
import { booleanStorage, jsonStorage, usePersistentState } from './hooks/usePersistentState.js';
import { useResponsiveLayout } from './hooks/useResponsiveLayout.js';
import { useThemeColorSync } from './hooks/useThemeColorSync.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSessionHandlers } from './hooks/useSessionHandlers.js';
import { useChatTransport } from './hooks/useChatTransport.js';
import { useAgentTransport } from './hooks/useAgentTransport.js';
import { DEFAULT_MODELS, SUGGESTIONS } from './data/suggestions.js';
import {
  PHONE_BREAKPOINT,
  TABLET_BREAKPOINT,
  DOCKED_LAYOUT_BREAKPOINT,
  APP_BG_COLOR,
  APP_SURFACE_COLOR,
  PANEL_SIZE_KEY,
} from './utils/constants.js';
import { formatMsgTime } from './utils/format.js';
import { shuffled } from './utils/random.js';
import { hasThinkContent } from './utils/markdown.js';

export default function App() {
  const {
    setChatState,
    sessions,
    activeSession,
    messages,
    chatModel,
    updateSession,
  } = useChatSessions();
  const [availableModels, setAvailableModels] = useState(DEFAULT_MODELS);
  // availableModels 在首屏渲染时先用 DEFAULT_MODELS 占位；
  // modelsLoaded 用来区分“占位值”和“真实从后端拿到的列表”，
  // 避免启动阶段误把用户已选的多模型裁成一个。
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [mode, setMode] = usePersistentState('nvidia_chat_last_mode', 'chat');
  const [suggestionSeed, setSuggestionSeed] = useState(0);
  const {
    streaming,
    setStreaming,
    agentRunning,
    setAgentRunning,
    agentStopping,
    setAgentStopping,
    setAgentRunId,
    reconnectedRun,
    setReconnectedRun,
    agentTrace,
    setAgentTrace,
    pendingApproval,
    setPendingApproval,
    approvalSubmitting,
    setApprovalSubmitting,
    agentCollapsed,
    setAgentCollapsed,
    showMemoryPanel,
    setShowMemoryPanel,
    rollbackLoading,
    setRollbackLoading,
    agentMobileTab,
    setAgentMobileTab,
    pendingQuestion,
    setPendingQuestion,
    questionSubmitting,
    setQuestionSubmitting,
    agentStartedAt,
    setAgentStartedAt,
    agentRunIdRef,
    agentAbortRef,
    approvalRequestRef,
    questionRequestRef,
    touchStartRef,
    reconnectTaskRef,
    lastAgentTaskRef,
  } = useAgentRun();
  const [agentMemory, setAgentMemory] = usePersistentState('agent_memory', true, booleanStorage);
  const [showReset, setShowReset] = useState(false);
  const { showSessions, setShowSessions } = useResponsiveLayout({
    dockedBreakpoint: DOCKED_LAYOUT_BREAKPOINT,
    tabletBreakpoint: TABLET_BREAKPOINT,
    panelSizeKey: PANEL_SIZE_KEY,
  });
  // Agent 的模型集合、策略、headless、memory 目前是“应用级偏好”，
  // 不跟随 chat session 存储；chat session 只保存单模型对话所用的 model。
  const [selectedAgentModels, setSelectedAgentModels] = usePersistentState('agent_models', [], jsonStorage);
  // Filter out models no longer available
  useEffect(() => {
    if (!modelsLoaded) {
      return;
    }
    // 只有在真正拿到后端模型列表之后才做清理：
    // 否则启动时会拿 DEFAULT_MODELS 这个占位值去过滤，
    // 把本地保存的多模型选择错误地写回成单模型。
    if (selectedAgentModels.length > 0 && availableModels.length > 0) {
      const valid = selectedAgentModels.filter(m => availableModels.some(avail => avail.id === m));
      if (valid.length !== selectedAgentModels.length) {
        setSelectedAgentModels(valid);
      }
    }
  }, [availableModels, modelsLoaded, selectedAgentModels, setSelectedAgentModels]);
  const [agentStrategy, setAgentStrategy] = usePersistentState('agent_strategy', 'race');

  // 桌面通知权限：default = 未询问，granted = 已开，denied = 用户拒绝过。
  // SW 在 App 挂载时静默注册，权限请求必须由用户点击触发。
  const [notifyPerm, setNotifyPerm] = useState(() => notificationPermission());
  useEffect(() => {
    ensureServiceWorker();
  }, []);
  const handleEnableNotifications = async () => {
    const result = await requestNotificationPermission();
    setNotifyPerm(result);
  };

  const abortRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  // 拉取后端可用模型。这里除了更新下拉/模型标签，
  // 还要顺手修正那些引用了已下线模型的历史聊天会话。
  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.models) && data.models.length > 0) {
          setAvailableModels(data.models);
          // Fix sessions with models not available on backend
          setChatState(prev => {
            const changed = prev.sessions.some(s => s.model && !data.models.some(m => m.id === s.model));
            if (!changed) return prev;
            const sessions = prev.sessions.map(s => {
              if (s.model && !data.models.some(m => m.id === s.model)) {
                return { ...s, model: data.models[0].id };
              }
              return s;
            });
            return { ...prev, sessions };
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        setModelsLoaded(true);
      });
  }, [setChatState]);

  const selectedChatModelLabel = availableModels.find(item => item.id === chatModel)?.label || chatModel;
  const sessionLocked = streaming || agentRunning;

  // 在移动端/窄屏时，会话侧栏和 Agent 面板会改变页面主色块区域。
  // 同步 <meta name="theme-color"> 是为了让浏览器地址栏颜色也跟着切换。
  useThemeColorSync({ mode, agentMobileTab, showSessions });

  // 页面刷新后，如果后端还有运行中的 agent，这里会尝试“接回去”：
  // 1. 先查 /api/agent/active
  // 2. 再订阅 /api/agent/stream/:runId
  // 3. 同时把 UI 切回 Agent 模式，并用占位消息保住聊天视图连续性
  useEffect(() => {
    const controller = new AbortController();
    let aborted = false;

    // 订阅回调可能在很久之后才触发，不能依赖闭包里的 activeSession。
    // 每次都从最新 chatState 里拿 activeSessionId，避免事件写错会话。
    const updateActiveSession = updater => {
      setChatState(prev => {
        const sid = prev.activeSessionId;
        const sessions = prev.sessions.map(session => {
          if (session.id === sid) return updater(session);
          return session;
        });
        return normalizeChatState({ ...prev, sessions });
      });
    };

    (async () => {
      try {
        const res = await fetch('/api/agent/active', { signal: controller.signal });
        if (aborted) return;
        const data = await res.json();
        if (!data.active || aborted) return;

        setAgentRunning(true);
        setAgentTrace([]);
        setReconnectedRun(true);
        setAgentStartedAt(data.startedAt || null);
        setAgentRunId(data.runId);
        agentRunIdRef.current = data.runId;
        setMode('agent');
        agentAbortRef.current = controller;

        // 刷新重连时，如果当前会话看起来不是这次 Agent 任务对应的会话，
        // 就临时创建一个“占位会话”承接运行态，避免把其他历史会话的消息替换掉。
        const task = data.task || 'Agent 任务';
        setChatState(prev => {
          const cur = prev.sessions.find(s => s.id === prev.activeSessionId);
          const firstUser = cur?.messages?.find(m => m.role === 'user');
          if (firstUser && firstUser.content === task) return prev;
          const cleanSession = createSession({
            messages: [
              { role: 'user', content: task, ts: data.startedAt || Date.now() },
              { role: 'assistant', content: 'Desktop Agent 正在执行任务，请稍候…', ts: Date.now() },
            ],
            agentRunId: data.runId,
          });
          return normalizeChatState({
            sessions: [cleanSession, ...prev.sessions],
            activeSessionId: cleanSession.id,
          });
        });

        const response = await fetch(`/api/agent/stream/${data.runId}`, { signal: controller.signal });
        if (!response.ok || aborted) {
          setAgentRunning(false);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const dataLine = line.replace(/^data:\s*/, '');
            if (!dataLine || dataLine === '[DONE]') continue;
            try {
              const event = JSON.parse(dataLine);

              if (event.type === 'run_meta') {
                setAgentStartedAt(event.startedAt || null);
                if (event.task) reconnectTaskRef.current = event.task;
                continue;
              }

              // SSE 重连时同一批事件可能会回放两次；这里按关键字段去重，
              // 否则 trace 面板会出现重复步骤。
              setAgentTrace(prev => {
                if (prev.some(e => e.type === event.type && e.step === event.step && e.stage === event.stage && e.model === event.model)) {
                  return prev;
                }
                return [...prev, event];
              });

              if (event.type === 'approval_required') {
                approvalRequestRef.current = { ...event, resolve: () => {} };
                setPendingApproval(event);
              }

              if (event.type === 'question_required') {
                questionRequestRef.current = { ...event, resolve: () => {} };
                setPendingQuestion(event);
              }

              if (event.type === 'user_response') {
                setPendingApproval(null);
                setPendingQuestion(null);
                approvalRequestRef.current = null;
                questionRequestRef.current = null;
              }

              if (event.type === 'approval_result') {
                setPendingApproval(null);
                approvalRequestRef.current = null;
              }

              if (event.type === 'rollback') {
                setAgentTrace(prev => {
                  const target = event.targetStep;
                  return prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step < target);
                });
              }

              if (event.type === 'done') {
                setAgentRunning(false);
                updateActiveSession(session => {
                  const msgs = [...session.messages];
                  const idx = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant' && msgs[i].content.includes('正在执行任务')) return i; } return -1; })();
                  if (idx >= 0) {
                    msgs[idx] = { role: 'assistant', content: event.answer || 'Agent 已完成任务。' };
                  } else if (!msgs.some(m => m.role === 'assistant' && m.content === (event.answer || ''))) {
                    msgs.push({ role: 'user', content: reconnectTaskRef.current || data.task || 'Agent 任务', ts: data.startedAt || Date.now() });
                    msgs.push({ role: 'assistant', content: event.answer || 'Agent 已完成任务。', ts: Date.now() });
                  }
                  return touchSession(session, { messages: msgs, agentRunId: data.runId });
                });
              }

              if (event.type === 'error') {
                setAgentRunning(false);
              }
            } catch { /* skip malformed SSE lines */ }
          }
        }
        setAgentRunning(false);
      } catch (err) {
        if (err.name === 'AbortError') {
          setAgentRunning(false);
        }
      }
    })();

    return () => {
      aborted = true;
      controller.abort();
    };
  // 这段只负责页面首次加载后的运行态接回；依赖更新不应该重新订阅同一个 run。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手机后台/切 tab 时浏览器会冻结 JS、节流网络，SSE reader 可能在后台错过
  // done/error 事件；切回前台时如果前端还以为任务在跑，就调一次持久化的 trace
  // 接口兜底：trace 里如果已经包含 done/error，把 answer 灌回对应 session 并
  // 把 running 状态收掉，避免出现"任务已结束但 UI 一直转圈"。
  useEffect(() => {
    if (!agentRunning) return;
    let cancelled = false;

    const checkOnVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const rid = agentRunIdRef.current;
      if (!rid) return;
      let events;
      try {
        events = await fetchAgentTrace(rid);
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(events) || events.length === 0) return;

      const terminal = events.find(e => e.type === 'done' || e.type === 'error');
      if (!terminal) return;

      setAgentTrace(prev => {
        if (prev.some(e => e.type === terminal.type)) return prev;
        return [...prev, terminal];
      });

      const content = terminal.type === 'done'
        ? (terminal.answer || 'Agent 已完成任务。')
        : `⚠️ Desktop Agent 失败：${terminal.error || '未知错误'}`;

      setChatState(prev => {
        let changed = false;
        const sessions = prev.sessions.map(session => {
          if (session.agentRunId !== rid) return session;
          const msgs = [...session.messages];
          let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i].role === 'assistant' && msgs[i].content?.includes('正在执行任务')) {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            msgs[idx] = { role: 'assistant', content, ts: Date.now() };
          } else if (!msgs.some(m => m.role === 'assistant' && m.content === content)) {
            msgs.push({ role: 'assistant', content, ts: Date.now() });
          } else {
            return session;
          }
          changed = true;
          return touchSession(session, { messages: msgs, agentRunId: rid });
        });
        if (!changed) return prev;
        return normalizeChatState({ ...prev, sessions });
      });

      setAgentRunning(false);
      setPendingApproval(null);
      setPendingQuestion(null);
    };

    document.addEventListener('visibilitychange', checkOnVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', checkOnVisible);
    };
  // setter 引用稳定，rid 用 ref 读最新值
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRunning]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    // 普通切换会话时，Agent trace 跟着 active session 走；
    // 但如果当前正处在“刷新后重连中的运行态”，不要被旧 session 覆盖掉。
    if (agentRunning) return;
    const controller = new AbortController();
    const savedTrace = activeSession.agentTrace || [];
    const savedRunId = activeSession.agentRunId || savedTrace.find(e => e.runId)?.runId || null;
    setAgentTrace(savedTrace);
    if (savedRunId) {
      agentRunIdRef.current = savedRunId;
      setAgentRunId(savedRunId);
      fetchAgentTrace(savedRunId, { signal: controller.signal })
        .then(events => {
          if (events.length === 0 || controller.signal.aborted) return;
          const deduped = events.filter((e, i) => {
            const key = `${e.type}:${e.step ?? ''}:${e.stage ?? ''}:${e.model ?? ''}`;
            return !events.slice(0, i).some(p => `${p.type}:${p.step ?? ''}:${p.stage ?? ''}:${p.model ?? ''}` === key);
          });
          setAgentTrace(deduped);
          updateSession(activeSession.id, session => touchSession(session, {
            agentRunId: savedRunId,
            agentTrace: deduped,
          }));
        })
        .catch(() => {});
    } else {
      agentRunIdRef.current = null;
      setAgentRunId(null);
    }
    // Recover last agent task text from session messages for rollback retry
    const lastUserMsg = [...(activeSession.messages || [])].reverse().find(m => m.role === 'user');
    lastAgentTaskRef.current = lastUserMsg?.content || null;
    setAgentStartedAt(null);
    setPendingApproval(null);
    approvalRequestRef.current = null;
    return () => controller.abort();
  // 这里按会话切换同步 trace，不能跟随消息增量每次重置运行态。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession.id]);

  // Keyboard shortcuts: Cmd/Ctrl+Shift+E collapse panel, Cmd/Ctrl+Shift+M toggle memory
  useKeyboardShortcuts({ mode, setAgentCollapsed, setShowMemoryPanel, setShowSessions, showMemoryPanel });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeSession.id, agentTrace]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  useEffect(() => {
    return () => {
      // 页面卸载时同时中止 chat / agent 的网络流，
      // 也顺手拒绝掉所有等待中的审批 Promise，避免悬挂。
      abortRef.current?.abort();
      agentAbortRef.current?.abort();
      approvalRequestRef.current?.resolve?.('reject');
    };
  }, [agentAbortRef, approvalRequestRef]);

  const { sendChatMessage, stopGeneration } = useChatTransport({
    activeSession,
    messages,
    chatModel,
    updateSession,
    setStreaming,
    setInput,
    abortRef,
    textareaRef,
  });

  const {
    handleCreateSession,
    handleSelectSession,
    handleDeleteSession,
    handleClearAllSessions,
    handleReset,
    setChatModel,
  } = useSessionHandlers({
    sessions,
    activeSession,
    sessionLocked,
    setChatState,
    setInput,
    setShowReset,
    setShowSessions,
    updateSession,
    textareaRef,
  });

  const { sendAgentTask, stopAgent, handleRollback, handleApprovalDecision } = useAgentTransport({
    activeSession,
    messages,
    agentTrace,
    agentRunning,
    selectedAgentModels,
    chatModel,
    agentStrategy,
    agentMemory,
    availableModels,
    agentRunIdRef,
    agentAbortRef,
    approvalRequestRef,
    questionRequestRef,
    lastAgentTaskRef,
    textareaRef,
    setInput,
    setAgentTrace,
    setAgentRunning,
    setAgentStopping,
    setAgentStartedAt,
    setPendingApproval,
    setPendingQuestion,
    setReconnectedRun,
    setRollbackLoading,
    setAgentMobileTab,
    setAgentRunId,
    setApprovalSubmitting,
    updateSession,
  });

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || sessionLocked) {
      return;
    }

    // 同一输入框根据 mode 分流到两套完全不同的执行链路。
    if (mode === 'agent') {
      await sendAgentTask(text);
      return;
    }

    await sendChatMessage(text);
  };

  const handleKeyDown = e => {
    const isMobile = window.innerWidth < TABLET_BREAKPOINT;
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const sessionStarted = messages.length > 0;

  const suggestions = useMemo(() => {
    void activeSession.id;
    void suggestionSeed;
    const pool = SUGGESTIONS[mode];
    const count = mode === 'agent' ? 8 : 4;
    return shuffled(pool).slice(0, count);
  }, [mode, activeSession.id, suggestionSeed]);

  const modeSwitch = !sessionStarted && (
    <div className="mode-switch" aria-label="模式切换">
      <button className={`mode-btn ${mode === 'chat' ? 'active' : ''}`} onClick={() => setMode('chat')} disabled={sessionLocked}>
        对话
      </button>
      <button className={`mode-btn ${mode === 'agent' ? 'active' : ''}`} onClick={() => setMode('agent')} disabled={sessionLocked}>
        Agent
      </button>
    </div>
  );

  const toggleAgentModel = id => {
    setSelectedAgentModels(prev => {
      const next = prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id];
      return next;
    });
  };

  const moveAgentModel = (id, dir) => {
    setSelectedAgentModels(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  const modelSelect = !sessionStarted
    ? mode === 'agent' ? (
      <div className="model-tags-wrap">
        <div className="model-tags">
          {availableModels.map(item => {
            const isSelected = selectedAgentModels.includes(item.id);
            const orderIdx = selectedAgentModels.indexOf(item.id);
            return (
              <span key={item.id} className={`model-tag-wrapper ${isSelected ? 'selected' : ''}`}>
                <button
                  className={`model-tag ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleAgentModel(item.id)}
                  disabled={sessionLocked}
                  title={isSelected ? '取消选择' : '选择并发执行'}
                >
                  {item.label}
                </button>
                {isSelected && selectedAgentModels.length > 1 && (
                  <span className="model-tag-order">
                    <button className="order-arrow" onClick={() => moveAgentModel(item.id, -1)} disabled={orderIdx <= 0 || sessionLocked} title="提高优先级"><ChevronUp size={10} /></button>
                    <span className="order-number">{orderIdx + 1}</span>
                    <button className="order-arrow" onClick={() => moveAgentModel(item.id, 1)} disabled={orderIdx >= selectedAgentModels.length - 1 || sessionLocked} title="降低优先级"><ChevronDown size={10} /></button>
                  </span>
                )}
              </span>
            );
          })}
        </div>
        {selectedAgentModels.length > 1 && (
          <div className="strategy-toggle">
            <button
              className={`strategy-btn ${agentStrategy === 'race' ? 'active' : ''}`}
              onClick={() => setAgentStrategy('race')}
              disabled={sessionLocked}
              title="按优先级分批启动，先到先得"
            >竞速</button>
            <button
              className={`strategy-btn ${agentStrategy === 'vote' ? 'active' : ''}`}
              onClick={() => setAgentStrategy('vote')}
              disabled={sessionLocked}
              title="等待所有模型完成，投票选最优"
            >汇总</button>
          </div>
        )}
      </div>
    ) : (
      <select className="model-select" value={chatModel} onChange={e => setChatModel(e.target.value)} title="切换模型">
        {availableModels.map(item => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>
    )
    : null;

  const sendButton = streaming ? (
    <button className="send-btn stop" onClick={stopGeneration}><Square size={12} /> 停止</button>
  ) : agentRunning ? (
    <button className="send-btn stop" onClick={stopAgent} disabled={agentStopping}>
      <Square size={12} /> {agentStopping ? '正在停止…' : pendingApproval ? '停止并拒绝' : '停止'}
    </button>
  ) : (
    <button className="send-btn idle" onClick={handleSubmit} disabled={!input.trim()}>
      <Send size={14} /> 发送
    </button>
  );

  const memoryToggle = mode === 'agent' && !sessionStarted && (
    <button
      className={`toolbar-chip ${agentMemory ? 'active' : ''}`}
      onClick={() => setAgentMemory(v => !v)}
      title={agentMemory ? '使用历史记忆辅助任务' : '不使用记忆'}
    >
      <Brain size={12} /> {agentMemory ? '记忆开' : '记忆关'}
    </button>
  );

  const showHero = messages.length === 0 && !agentRunning;

  return (
    <ErrorBoundary>
    <div className="app-shell">
      <SessionSidebar open={showSessions} onClose={() => setShowSessions(false)}>
        <SessionList
          sessions={sessions}
          activeSessionId={activeSession.id}
          modelList={availableModels}
          onDelete={handleDeleteSession}
          onClearAll={handleClearAllSessions}
          onSelect={(id) => { handleSelectSession(id); if (window.innerWidth < 768) setShowSessions(false); }}
          locked={sessionLocked}
          showMemoryPanel={showMemoryPanel}
          onToggleMemory={() => setShowMemoryPanel(v => !v)}
        />
      </SessionSidebar>

      <div className="main-area">
      {agentRunning && notificationsSupported() && (notifyPerm === 'default' || notifyPerm === 'denied') && (
        <div className="notify-banner">
          {notifyPerm === 'default' ? (
            <>
              <span>桌面通知未开启，开启后 Agent 等待审批时会在桌面提醒你。</span>
              <button className="notify-banner-btn" onClick={handleEnableNotifications}>开启桌面通知</button>
            </>
          ) : (
            <span>
              桌面通知被浏览器阻止了。打开
              {' '}
              <code>chrome://settings/content/siteDetails?site={window.location.origin}</code>
              {' '}
              把「通知」改为「允许」，然后刷新页面。
            </span>
          )}
          <button className="notify-banner-close" onClick={() => setNotifyPerm('dismissed')} title="先不开">×</button>
        </div>
      )}
      {showHero && (
        <button className="page-create-btn" onClick={handleCreateSession} disabled={sessionLocked} title="新建会话">
          + 新建
        </button>
      )}
      {showHero ? (
        <div className="hero-wrap">
          <div className="hero">
            <button className="session-toggle-btn hero-menu" onClick={() => setShowSessions(v => !v)} title="会话列表">
              <Menu size={16} />
            </button>

            <div className="hero-brand">
              <h1 className="hero-title">sagent</h1>
              <p className="hero-subtitle">多模型 AI 聊天 + 桌面 Agent</p>
            </div>

            <div className="hero-input-card">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={mode === 'agent' ? '描述要让 Agent 完成的任务…' : '输入消息…'}
                rows={2}
                disabled={sessionLocked}
              />
              <div className="hero-toolbar">
                {modeSwitch}
                {modelSelect}
                {memoryToggle}
                {sendButton}
              </div>
            </div>

            <div className="suggestions-head">
              <span className="suggestions-label">{mode === 'agent' ? '试试这些任务' : '试试这些问题'}</span>
              <button
                className="suggestions-refresh"
                onClick={() => setSuggestionSeed(v => v + 1)}
                disabled={sessionLocked}
                title="换一组"
              >
                <RotateCcw size={12} /> 换一组
              </button>
            </div>

            <div className="suggestions">
              {suggestions.map(s => (
                <button key={s.title} className="suggestion-card"
                  onClick={() => { setInput(s.text); textareaRef.current?.focus(); }}
                  onDoubleClick={() => { setInput(s.text); setTimeout(() => handleSubmit(), 0); }}
                >
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-text">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="layout">
          {reconnectedRun && agentRunning && (
            <div className="reconnect-banner">
              检测到运行中的 Agent 任务，已自动连接。可点击"停止"取消。
            </div>
          )}
          <div className="header">
            <div className="header-left">
              <button className="session-toggle-btn" onClick={() => setShowSessions(v => !v)} title="会话列表">
                <Menu size={16} />
              </button>
              <button className="header-new-session-btn" onClick={handleCreateSession} disabled={sessionLocked} title="新建会话">
                + 新建
              </button>
              <span className="header-session-title">{getSessionTitle(messages)}</span>
            </div>
            <div className="header-right">
              {modeSwitch}
              {modelSelect}
              {sessionStarted && mode !== 'agent' && (
                <span className="header-model-label">{selectedChatModelLabel}</span>
              )}
              <button className="header-icon-btn" onClick={() => setShowReset(true)} title="清空" disabled={messages.length === 0 || sessionLocked}><Trash2 size={14} /></button>
            </div>
          </div>

          <div className={`layout-body ${mode === 'agent' ? 'agent-layout' : 'chat-layout'}`}>
          {mode === 'agent' && (
            <AgentPane
              agentMobileTab={agentMobileTab}
              setAgentMobileTab={setAgentMobileTab}
              agentRunning={agentRunning}
              agentTrace={agentTrace}
              touchStartRef={touchStartRef}
              agentPanel={(
                <AgentPanel
                  mode={mode}
                  running={agentRunning}
                  trace={agentTrace}
                  startedAt={agentStartedAt}
                  modelList={availableModels}
                  collapsed={agentCollapsed}
                  onToggleCollapse={() => setAgentCollapsed(c => !c)}
                  onStop={stopAgent}
                  agentStopping={agentStopping}
                  pendingApproval={pendingApproval}
                  onRollback={handleRollback}
                  rollbackLoading={rollbackLoading}
                />
              )}
              resizeDivider={<ResizeDivider side="agent" />}
            />
          )}

          {messages.length > 0 && (
            <ChatPane
              hidden={mode === 'agent' && agentMobileTab === 'agent'}
              messages={messages}
              streaming={streaming}
              bottomRef={bottomRef}
              textareaRef={textareaRef}
              inputValue={input}
              setInput={setInput}
              handleKeyDown={handleKeyDown}
              placeholder={mode === 'agent' ? '描述要让 Agent 完成的任务…' : '输入消息…'}
              disabled={sessionLocked}
              memoryToggle={memoryToggle}
              sendButton={sendButton}
              touchStartRef={touchStartRef}
              agentMobileTab={agentMobileTab}
              setAgentMobileTab={setAgentMobileTab}
              renderMessageContent={props => <MessageContent {...props} />}
              renderCopyButton={props => <CopyButton {...props} />}
              hasThinkContent={hasThinkContent}
              formatMsgTime={formatMsgTime}
            />
          )}

          </div>

        </div>
      )}

      </div>

      <ApprovalDialog
        approval={pendingApproval}
        submitting={approvalSubmitting}
        onApprove={() => handleApprovalDecision('approve')}
        onReject={() => handleApprovalDecision('reject')}
      />

      <QuestionDialog
        question={pendingQuestion}
        submitting={questionSubmitting}
        onSubmit={async (response) => {
          if (!pendingQuestion) return;
          setQuestionSubmitting(true);
          try {
            await submitAgentQuestion({
              runId: pendingQuestion.runId,
              approvalId: pendingQuestion.approvalId,
              response,
            });
            setPendingQuestion(null);
            questionRequestRef.current?.resolve?.(response);
          } catch (err) {
            console.error('Question submit failed:', err);
          } finally {
            setQuestionSubmitting(false);
          }
        }}
        onSkip={() => {
          setPendingQuestion(null);
          questionRequestRef.current?.resolve?.('');
        }}
      />

      {showReset && <ResetDialog onConfirm={handleReset} onCancel={() => setShowReset(false)} />}
    </div>
    </ErrorBoundary>
  );
}
