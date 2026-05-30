import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { fetchAgentTrace } from './api/streams.js';
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
import { ModelSelector } from './components/ModelSelector.jsx';
import { ModeSwitch } from './components/ModeSwitch.jsx';
import { SendButton } from './components/SendButton.jsx';
import { MemoryToggle } from './components/MemoryToggle.jsx';
import { AttachButton } from './components/AttachButton.jsx';
import { AttachmentBar } from './components/AttachmentBar.jsx';
import { NotificationBanner } from './components/NotificationBanner.jsx';
import { AppHeader } from './components/AppHeader.jsx';
import { HeroScreen } from './components/HeroScreen.jsx';
import { useAgentRun } from './hooks/useAgentRun.js';
import { createSession, getSessionTitle, normalizeChatState, touchSession, useChatSessions } from './hooks/useChatSessions.js';
import { booleanStorage, jsonStorage, usePersistentState } from './hooks/usePersistentState.js';
import { useResponsiveLayout } from './hooks/useResponsiveLayout.js';
import { useThemeColorSync } from './hooks/useThemeColorSync.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSessionHandlers } from './hooks/useSessionHandlers.js';
import { useChatTransport } from './hooks/useChatTransport.js';
import { useAgentTransport } from './hooks/useAgentTransport.js';
import { useQuestionSubmit } from './hooks/useQuestionSubmit.js';
import { useAttachments } from './hooks/useAttachments.js';
import { DEFAULT_MODELS, EMPTY_SUGGESTIONS } from './data/suggestions.js';
import { fetchSuggestions, recordSuggestionUse } from './api/suggestions.js';
import {
  TABLET_BREAKPOINT,
  DOCKED_LAYOUT_BREAKPOINT,
  APP_BG_COLOR,
  APP_SURFACE_COLOR,
  PANEL_SIZE_KEY,
} from './utils/constants.js';
import { formatMsgTime } from './utils/format.js';
import { shuffled } from './utils/random.js';
import { hasThinkContent } from './utils/markdown.js';

// 把已上传的附件拼到任务文本中。
// 单独成段 [附件] 块,让 LLM 容易识别;对图片显式提示 image_analyze 工具,
// 其它类型留作扩展(例如以后加 PDF 时,这里就给"请用 read_file 阅读"之类的提示)。
function buildTaskWithAttachments(userText, attachments) {
  if (!attachments || attachments.length === 0) {
    return userText;
  }
  const lines = ['[附件]'];
  for (const att of attachments) {
    if (att.kind === 'image') {
      lines.push(`- 图片: ${att.path}(请用 image_analyze 工具分析)`);
    } else {
      lines.push(`- 文件: ${att.path}(${att.mime || '未知类型'})`);
    }
  }
  const block = lines.join('\n');
  return userText ? `${userText}\n\n${block}` : block;
}

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
  const [suggestionData, setSuggestionData] = useState(EMPTY_SUGGESTIONS);
  const [activeCategoryId, setActiveCategoryId] = useState(null);
  // 卡片点击时把标题暂存,handleSubmit 时上报给后端;手动输入则降级到 text 前 12 字
  const pendingTitleRef = useRef(null);
  const {
    streaming,
    setStreaming,
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
    runsState,
    dispatch,
    getRun,
    abortControllersRef,
    touchStartRef,
  } = useAgentRun();
  // 当前 active session 对应的 run(多 run 并发时,UI 只展示当前 session 的 run)。
  const activeRunId = activeSession.agentRunId || null;
  const activeRun = activeRunId ? runsState.byId.get(activeRunId) || null : null;
  const agentRunning = !!activeRun?.running;
  const agentStopping = !!activeRun?.stopping;
  const agentTrace = activeRun?.trace ?? activeSession.agentTrace ?? [];
  const agentStartedAt = activeRun?.startedAt ?? null;
  const pendingApproval = activeRun?.pendingApproval ?? null;
  const pendingQuestion = activeRun?.pendingQuestion ?? null;
  const reconnectedRun = !!activeRun?.reconnected;
  // 侧栏多 run 标记:正在跑的 session、有待审批/提问的 session
  const runningSessionIds = useMemo(() => {
    const ids = new Set();
    for (const run of runsState.byId.values()) {
      if (run.running && run.sessionId) ids.add(run.sessionId);
    }
    return ids;
  }, [runsState]);
  const attentionSessionIds = useMemo(() => {
    const ids = new Set();
    for (const run of runsState.byId.values()) {
      if ((run.pendingApproval || run.pendingQuestion) && run.sessionId) ids.add(run.sessionId);
    }
    return ids;
  }, [runsState]);
  const [agentMemory, setAgentMemory] = usePersistentState('agent_memory', true, booleanStorage);
  const [showReset, setShowReset] = useState(false);
  const { showSessions, setShowSessions } = useResponsiveLayout({
    dockedBreakpoint: DOCKED_LAYOUT_BREAKPOINT,
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

  // 页面刷新后,把后端所有正在运行的 agent 任务"接回来"(多 run):
  // 1. GET /api/agent/runs 拿到所有活跃 run
  // 2. 逐个按 agentRunId 匹配到对应 session(匹配不到才建占位 session)
  // 3. 各起独立 SSE 订阅,事件写回各自的 session,不强制切换 active session
  useEffect(() => {
    const controllers = [];
    let aborted = false;

    // 单个 run 的 SSE 读循环:事件 dispatch 到对应 runId 分片 + 落回 session。
    const subscribeRun = async (runId, sessionId, startedAt) => {
      const controller = new AbortController();
      controllers.push(controller);
      abortControllersRef.current.set(runId, controller);
      dispatch({ type: 'start', runId, sessionId, startedAt: startedAt || Date.now(), reconnected: true });

      let response;
      try {
        response = await fetch(`/api/agent/stream/${runId}`, { signal: controller.signal });
      } catch {
        dispatch({ type: 'finish', runId });
        return;
      }
      if (!response.ok || aborted) {
        dispatch({ type: 'finish', runId });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const dataLine = line.replace(/^data:\s*/, '');
            if (!dataLine || dataLine === '[DONE]') continue;
            let event;
            try { event = JSON.parse(dataLine); } catch { continue; }

            if (event.type === 'run_meta') {
              if (event.startedAt) dispatch({ type: 'setStartedAt', runId, startedAt: event.startedAt });
              continue;
            }
            dispatch({ type: 'appendTrace', runId, event });

            if (event.type === 'approval_required') {
              dispatch({ type: 'setApproval', runId, approval: { ...event, resolve: () => {} } });
            } else if (event.type === 'question_required') {
              dispatch({ type: 'setQuestion', runId, question: { ...event, resolve: () => {} } });
            } else if (event.type === 'approval_result') {
              dispatch({ type: 'setApproval', runId, approval: null });
            } else if (event.type === 'user_response') {
              dispatch({ type: 'setApproval', runId, approval: null });
              dispatch({ type: 'setQuestion', runId, question: null });
            } else if (event.type === 'rollback') {
              const run = getRun(runId);
              if (run) {
                const target = event.targetStep;
                dispatch({ type: 'setTrace', runId, trace: run.trace.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step <= target) });
              }
            } else if (event.type === 'done' || event.type === 'error') {
              const content = event.type === 'done'
                ? (event.answer || 'Agent 已完成任务。')
                : `⚠️ Desktop Agent 失败:${event.error || '未知错误'}`;
              updateSession(sessionId, session => {
                const msgs = [...session.messages];
                let idx = -1;
                for (let i = msgs.length - 1; i >= 0; i -= 1) {
                  if (msgs[i].role === 'assistant' && msgs[i].content?.includes('正在执行任务')) { idx = i; break; }
                }
                if (idx >= 0) msgs[idx] = { role: 'assistant', content, ts: Date.now() };
                else if (!msgs.some(m => m.role === 'assistant' && m.content === content)) msgs.push({ role: 'assistant', content, ts: Date.now() });
                const run = getRun(runId);
                return touchSession(session, { messages: msgs, agentTrace: run?.trace || [], agentRunId: runId });
              });
            }
          }
        }
      } catch {
        // AbortError / 网络中断:落终态
      } finally {
        abortControllersRef.current.delete(runId);
        dispatch({ type: 'finish', runId });
      }
    };

    (async () => {
      let runs = [];
      try {
        const res = await fetch('/api/agent/runs');
        if (aborted) return;
        const data = await res.json();
        runs = Array.isArray(data.runs) ? data.runs : [];
      } catch {
        return;
      }
      if (aborted || runs.length === 0) return;

      for (const run of runs) {
        // 先在现有 sessions 里按 agentRunId 找归属;找不到才建占位 session(匹配先于创建,避免重复)
        let targetSessionId = null;
        setChatState(prev => {
          const existing = prev.sessions.find(s => s.agentRunId === run.runId);
          if (existing) { targetSessionId = existing.id; return prev; }
          const task = run.task || 'Agent 任务';
          const cleanSession = createSession({
            messages: [
              { role: 'user', content: task, ts: run.startedAt || Date.now() },
              { role: 'assistant', content: 'Desktop Agent 正在执行任务,请稍候…', ts: Date.now() },
            ],
            agentRunId: run.runId,
          });
          targetSessionId = cleanSession.id;
          return normalizeChatState({ sessions: [cleanSession, ...prev.sessions], activeSessionId: prev.activeSessionId });
        });
        if (targetSessionId) subscribeRun(run.runId, targetSessionId, run.startedAt);
      }
    })();

    return () => {
      aborted = true;
      controllers.forEach(c => c.abort());
    };
  // 只在首次加载接回运行态,依赖更新不应重新订阅。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手机后台/切 tab 时浏览器会冻结 JS、节流网络,SSE reader 可能在后台错过
  // done/error 事件;切回前台时如果当前 run 还以为在跑,调持久化 trace 接口兜底:
  // trace 里若已含 done/error,把 answer 灌回对应 session 并收掉 running 状态。
  useEffect(() => {
    if (!agentRunning || !activeRunId) return;
    let cancelled = false;
    const rid = activeRunId;

    const checkOnVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      let events;
      try {
        events = await fetchAgentTrace(rid);
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(events) || events.length === 0) return;

      const terminal = events.find(e => e.type === 'done' || e.type === 'error');
      if (!terminal) return;

      dispatch({ type: 'appendTrace', runId: rid, event: terminal });

      const content = terminal.type === 'done'
        ? (terminal.answer || 'Agent 已完成任务。')
        : `⚠️ Desktop Agent 失败:${terminal.error || '未知错误'}`;

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

      dispatch({ type: 'finish', runId: rid });
    };

    document.addEventListener('visibilitychange', checkOnVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', checkOnVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRunning, activeRunId]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    // 切换会话时:若该 session 的 run 已不在运行时 Map 里(历史已结束的 run),
    // 从磁盘 trace 重建并落回 session.agentTrace,供 activeRun 兜底派生。
    // 若 run 仍在 Map 里(在跑/刚结束),trace 由 activeRun 直接派生,无需重建。
    const savedRunId = activeSession.agentRunId || (activeSession.agentTrace || []).find(e => e.runId)?.runId || null;
    if (!savedRunId || getRun(savedRunId)) return;
    const controller = new AbortController();
    fetchAgentTrace(savedRunId, { signal: controller.signal })
      .then(events => {
        if (events.length === 0 || controller.signal.aborted) return;
        const deduped = events.filter((e, i) => {
          const key = `${e.type}:${e.step ?? ''}:${e.stage ?? ''}:${e.model ?? ''}`;
          return !events.slice(0, i).some(p => `${p.type}:${p.step ?? ''}:${p.stage ?? ''}:${p.model ?? ''}` === key);
        });
        updateSession(activeSession.id, session => touchSession(session, { agentRunId: savedRunId, agentTrace: deduped }));
      })
      .catch(() => {});
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession.id]);

  // Keyboard shortcuts: Cmd/Ctrl+Shift+E collapse panel, Cmd/Ctrl+Shift+M toggle memory
  useKeyboardShortcuts({ mode, setAgentCollapsed, setShowMemoryPanel, setShowSessions, showMemoryPanel });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeSession.id, agentTrace]);

  // 建议数据从后端拉取;suggestionSeed 触发(刷新按钮 / 提交后)也会重新拉,让"最近使用"即时反映
  useEffect(() => {
    let cancelled = false;
    fetchSuggestions()
      .then(data => {
        if (cancelled) return;
        setSuggestionData(data);
        setActiveCategoryId(prev => prev ?? data.agent?.[0]?.id ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [suggestionSeed]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [input]);

  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      // 页面卸载时中止 chat 流 + 所有 agent run 的网络流。
      abortRef.current?.abort();
      for (const ac of controllers.values()) ac?.abort();
    };
  }, [abortControllersRef]);

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
    chatStreaming: streaming,
    runningSessionIds,
    setChatState,
    setInput,
    setShowReset,
    setShowSessions,
    updateSession,
    textareaRef,
  });

  const { sendAgentTask, stopAgent, handleRollback, handleApprovalDecision } = useAgentTransport({
    selectedAgentModels,
    chatModel,
    agentStrategy,
    agentMemory,
    availableModels,
    textareaRef,
    dispatch,
    getRun,
    abortControllersRef,
    setInput,
    setRollbackLoading,
    setAgentMobileTab,
    setApprovalSubmitting,
    updateSession,
  });
  // UI 上的停止/回滚/审批都针对"当前查看的 run"(activeRunId),包装一层绑定 runId。
  const stopActiveAgent = () => activeRunId && stopAgent(activeRunId);
  const rollbackActiveAgent = targetStep => activeRunId && handleRollback(activeRunId, targetStep);
  const approveActive = decision => activeRunId && handleApprovalDecision(activeRunId, decision);

  const {
    attachments,
    addFiles: addAttachmentFiles,
    removeAttachment,
    clearAttachments,
    consumeReady: consumeReadyAttachments,
    uploading: attachmentsUploading,
    hasReady: hasReadyAttachments,
  } = useAttachments();

  const handleSubmit = async () => {
    const userText = input.trim();
    if (!userText && !hasReadyAttachments) {
      return;
    }
    if (sessionLocked) {
      return;
    }
    if (attachmentsUploading) {
      // 还在上传:不提前发送,UI 上发送按钮已经禁用了,这里再兜一层。
      return;
    }

    // 拼出最终任务文本:正文 + (可选)附件说明。
    // 设计上独立成一段 [附件] 块,LLM 容易识别;
    // image 给出 image_analyze 提示,其它类型只描述路径,以后扩展由这里集中加规则。
    const readyAttachments = consumeReadyAttachments();
    const text = buildTaskWithAttachments(userText, readyAttachments);
    if (!text) {
      return;
    }

    // 把这次发送累计到后端使用记录,只对 agent 模式做(chat 模式建议少,不需要)
    // 标题用原始用户输入(userText),避免被附件提示污染。
    if (mode === 'agent') {
      const titleSource = userText || readyAttachments[0]?.name || '附件任务';
      const title = pendingTitleRef.current
        || (titleSource.length > 12 ? titleSource.slice(0, 12) + '…' : titleSource);
      pendingTitleRef.current = null;
      recordSuggestionUse({ title, text });
      // 下次返回 hero 时能看到新的"最近使用"
      setSuggestionSeed(v => v + 1);
    }

    // 同一输入框根据 mode 分流到两套完全不同的执行链路。
    if (mode === 'agent') {
      await sendAgentTask(text, activeSession.id);
      clearAttachments();
      return;
    }

    await sendChatMessage(text);
    clearAttachments();
  };

  const handleKeyDown = e => {
    const isMobile = window.innerWidth < TABLET_BREAKPOINT;
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const sessionStarted = messages.length > 0;

  const agentCategories = suggestionData.agent;

  const suggestions = useMemo(() => {
    void activeSession.id;
    void suggestionSeed;
    if (mode === 'agent') {
      const cat = agentCategories.find(c => c.id === activeCategoryId) ?? agentCategories[0];
      const pool = cat?.items ?? [];
      // "最近使用"已按最近请求时间倒序,保持顺序;其它分类随机抽样
      if (cat?.id === 'recent') {
        return pool.slice(0, Math.min(8, pool.length));
      }
      return shuffled(pool).slice(0, Math.min(8, pool.length));
    }
    const pool = suggestionData.chat;
    return shuffled(pool).slice(0, Math.min(4, pool.length));
  }, [mode, activeSession.id, suggestionSeed, activeCategoryId, agentCategories, suggestionData.chat]);

  // 工具栏控件实例化一次，在 hero 和 layout header 中复用——
  // 行为/状态完全一致，没必要在两处分别构造。
  const modeSwitch = (
    <ModeSwitch mode={mode} setMode={setMode} sessionLocked={sessionLocked} sessionStarted={sessionStarted} />
  );
  const modelSelect = (
    <ModelSelector
      sessionStarted={sessionStarted}
      mode={mode}
      availableModels={availableModels}
      chatModel={chatModel}
      setChatModel={setChatModel}
      selectedAgentModels={selectedAgentModels}
      setSelectedAgentModels={setSelectedAgentModels}
      agentStrategy={agentStrategy}
      setAgentStrategy={setAgentStrategy}
      sessionLocked={sessionLocked}
    />
  );
  const sendButton = (
    <SendButton
      streaming={streaming}
      agentRunning={agentRunning}
      agentStopping={agentStopping}
      pendingApproval={pendingApproval}
      // 输入栏要有正文 *或* 已就绪附件才能发送;上传中按钮也置灰。
      inputValue={attachmentsUploading ? '' : (input || (hasReadyAttachments ? ' ' : ''))}
      onSend={handleSubmit}
      onStopGeneration={stopGeneration}
      onStopAgent={stopActiveAgent}
    />
  );
  const memoryToggle = (
    <MemoryToggle mode={mode} sessionStarted={sessionStarted} agentMemory={agentMemory} setAgentMemory={setAgentMemory} />
  );
  const attachButton = (
    <AttachButton
      onPickFiles={addAttachmentFiles}
      uploading={attachmentsUploading}
      disabled={sessionLocked}
      // 目前限定图片;以后开放其它类型时把 accept 改宽,后端会按 mime 推 kind。
      accept="image/*"
      multiple
    />
  );
  const attachmentBar = (
    <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
  );

  const showHero = messages.length === 0 && !agentRunning;

  const { submitting: questionSubmitting, handleSubmit: handleQuestionSubmit, handleSkip: handleQuestionSkip } = useQuestionSubmit({
    pendingQuestion,
    clearQuestion: response => {
      if (!activeRunId) return;
      pendingQuestion?.resolve?.(response);
      dispatch({ type: 'setQuestion', runId: activeRunId, question: null });
    },
  });

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
          onSelect={(id) => { handleSelectSession(id); if (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT) setShowSessions(false); }}
          runningSessionIds={runningSessionIds}
          attentionSessionIds={attentionSessionIds}
          showMemoryPanel={showMemoryPanel}
          onToggleMemory={() => setShowMemoryPanel(v => !v)}
        />
      </SessionSidebar>

      <div className="main-area">
      {agentRunning && notificationsSupported() && (notifyPerm === 'default' || notifyPerm === 'denied') && (
        <NotificationBanner
          perm={notifyPerm}
          onEnable={handleEnableNotifications}
          onDismiss={() => setNotifyPerm('dismissed')}
        />
      )}
      {showHero && (
        <button className="page-create-btn" onClick={handleCreateSession} disabled={sessionLocked} title="新建会话">
          + 新建
        </button>
      )}
      {showHero ? (
        <HeroScreen
          mode={mode}
          input={input}
          setInput={setInput}
          onKeyDown={handleKeyDown}
          textareaRef={textareaRef}
          sessionLocked={sessionLocked}
          toolbarSlots={{ modeSwitch, modelSelect, memoryToggle, sendButton, attachButton }}
          attachmentBar={attachmentBar}
          suggestions={suggestions}
          categories={mode === 'agent' ? agentCategories : null}
          activeCategoryId={activeCategoryId}
          onSelectCategory={setActiveCategoryId}
          onShuffle={() => setSuggestionSeed(v => v + 1)}
          onPickSuggestion={(text, title) => {
            pendingTitleRef.current = title ?? null;
            setInput(text);
            textareaRef.current?.focus();
          }}
          onSubmitSuggestion={(text, title) => {
            pendingTitleRef.current = title ?? null;
            setInput(text);
            setTimeout(() => handleSubmit(), 0);
          }}
          onToggleSessions={() => setShowSessions(v => !v)}
        />
      ) : (
        <div className="layout">
          {reconnectedRun && agentRunning && (
            <div className="reconnect-banner">
              检测到运行中的 Agent 任务，已自动连接。可点击"停止"取消。
            </div>
          )}
          <AppHeader
            sessionTitle={getSessionTitle(messages)}
            sessionLocked={sessionLocked}
            messagesLength={messages.length}
            sessionStarted={sessionStarted}
            mode={mode}
            selectedChatModelLabel={selectedChatModelLabel}
            modeSwitch={modeSwitch}
            modelSelect={modelSelect}
            onToggleSessions={() => setShowSessions(v => !v)}
            onCreateSession={handleCreateSession}
            onReset={() => setShowReset(true)}
          />

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
                  onStop={stopActiveAgent}
                  agentStopping={agentStopping}
                  pendingApproval={pendingApproval}
                  onRollback={rollbackActiveAgent}
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
              attachButton={attachButton}
              attachmentBar={attachmentBar}
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
        onApprove={() => approveActive('approve')}
        onReject={() => approveActive('reject')}
      />

      <QuestionDialog
        question={pendingQuestion}
        submitting={questionSubmitting}
        onSubmit={handleQuestionSubmit}
        onSkip={handleQuestionSkip}
      />

      {showReset && <ResetDialog onConfirm={handleReset} onCancel={() => setShowReset(false)} />}
    </div>
    </ErrorBoundary>
  );
}
