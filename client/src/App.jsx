import { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Settings } from 'lucide-react';
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
import { SettingsDialog } from './components/dialogs/SettingsDialog.jsx';
import { SessionList } from './components/session/SessionList.jsx';
import { AgentPanel } from './components/agent/AgentPanel.jsx';
import { ModelSelector } from './components/ModelSelector.jsx';
import { ModeSwitch } from './components/ModeSwitch.jsx';
import { SendButton } from './components/SendButton.jsx';
import { AttachButton } from './components/AttachButton.jsx';
import { AttachmentBar } from './components/AttachmentBar.jsx';
import { NotificationBanner } from './components/NotificationBanner.jsx';
import { AppHeader } from './components/AppHeader.jsx';
import { HeroScreen } from './components/HeroScreen.jsx';
import { useAgentRun } from './hooks/useAgentRun.js';
import { createSession, getSessionTitle, normalizeChatState, touchSession, useChatSessions } from './hooks/useChatSessions.js';
import { useProjects } from './hooks/useProjects.js';
import { booleanStorage, usePersistentState, useProjectScopedState } from './hooks/usePersistentState.js';
import { useResponsiveLayout } from './hooks/useResponsiveLayout.js';
import { useThemeColorSync } from './hooks/useThemeColorSync.js';
import { useTheme } from './theme/ThemeProvider.jsx';
import { useT } from './i18n/I18nProvider.jsx';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSessionHandlers } from './hooks/useSessionHandlers.js';
import { useChatTransport } from './hooks/useChatTransport.js';
import { useAgentTransport } from './hooks/useAgentTransport.js';
import { useQuestionSubmit } from './hooks/useQuestionSubmit.js';
import { useAttachments } from './hooks/useAttachments.js';
import { DEFAULT_MODELS, EMPTY_SUGGESTIONS } from './data/suggestions.js';
import { fetchSuggestions, recordSuggestionUse } from './api/suggestions.js';
import { apiFetch } from './api/http.js';
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

// 稳定的空数组:作为 useProjectScopedState 的 initialValue,scope 缺省时返回同一引用,避免无谓重渲染。
const EMPTY_AGENT_MODELS = [];

// 把已上传的附件拼到任务文本中。
// 单独成段 [附件] 块,让 LLM 容易识别;对图片显式提示 image_analyze 工具,
// 其它类型留作扩展(例如以后加 PDF 时,这里就给"请用 read_file 阅读"之类的提示)。
function buildTaskWithAttachments(userText, attachments, t) {
  if (!attachments || attachments.length === 0) {
    return userText;
  }
  const lines = [t('attach.taskBlockHeader')];
  for (const att of attachments) {
    if (att.kind === 'image') {
      lines.push(t('attach.taskImageLine', { path: att.path }));
    } else {
      lines.push(t('attach.taskFileLine', { path: att.path, mime: att.mime || t('attach.unknownType') }));
    }
  }
  const block = lines.join('\n');
  return userText ? `${userText}\n\n${block}` : block;
}

function uniqueModelIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()))];
}

function getTraceModels(trace) {
  if (!Array.isArray(trace)) {
    return [];
  }

  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const models = uniqueModelIds(trace[i]?.meta?.models_used);
    if (models.length > 0) {
      return models;
    }
  }

  return uniqueModelIds(trace.flatMap(event => {
    if (event?.type !== 'model_plan') return [];
    return event.model ? [event.model] : event.models;
  }));
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
  const {
    projects,
    activeProjectId,
    loading: projectsLoading,
    createProject,
    updateProject,
    deleteProject,
    activateProject,
  } = useProjects();
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
  const [showSettings, setShowSettings] = useState(false);
  const { showSessions, setShowSessions } = useResponsiveLayout({
    dockedBreakpoint: DOCKED_LAYOUT_BREAKPOINT,
    panelSizeKey: PANEL_SIZE_KEY,
  });
  // Agent 的多模型选择与策略「按项目」存储:useProjectScopedState 内部按 activeProjectId 分桶,
  // 切项目时派生值自动跟着变。chat 单模型走 session(本身已按项目过滤);memory 仍是应用级偏好。
  const [selectedAgentModels, setSelectedAgentModels] = useProjectScopedState('agent_models_by_project', activeProjectId, EMPTY_AGENT_MODELS);
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
  const [agentStrategy, setAgentStrategy] = useProjectScopedState('agent_strategy_by_project', activeProjectId, 'race');

  // 一次性迁移:历史版本 agent 模型/策略是全局存储(所有项目共用一份),现改为按项目存。
  // 等项目就绪(projectsLoading=false,此时 activeProjectId 已是后端真实值)后跑一次,
  // 把旧的全局选择迁移到「当前项目」名下,再删旧 key;其余项目从空开始。
  const agentPrefsMigratedRef = useRef(false);
  useEffect(() => {
    if (projectsLoading || agentPrefsMigratedRef.current) return;
    agentPrefsMigratedRef.current = true;
    try {
      const legacy = localStorage.getItem('agent_models');
      if (legacy != null) {
        const parsed = JSON.parse(legacy);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSelectedAgentModels(prev => (prev.length ? prev : parsed));
        }
        localStorage.removeItem('agent_models');
      }
    } catch { /* 忽略损坏的旧数据 */ }
    try {
      const legacy = localStorage.getItem('agent_strategy');
      if (legacy != null) {
        setAgentStrategy(prev => (prev && prev !== 'race' ? prev : legacy));
        localStorage.removeItem('agent_strategy');
      }
    } catch { /* 忽略损坏的旧数据 */ }
  }, [projectsLoading, setSelectedAgentModels, setAgentStrategy]);

  // 刷新或切回历史 Agent 会话时，如果项目级选择为空，就用该会话上次运行的模型
  // 恢复选择器状态。只对每个 active session 自动恢复一次，避免用户手动清空后被立刻填回。
  const seededAgentModelsSessionRef = useRef(null);
  useEffect(() => {
    if (mode !== 'agent' || seededAgentModelsSessionRef.current === activeSession.id) {
      return;
    }
    if (selectedAgentModels.length > 0) {
      seededAgentModelsSessionRef.current = activeSession.id;
      return;
    }
    const sessionModels = uniqueModelIds(
      activeSession.modelsUsed?.length > 0
        ? activeSession.modelsUsed
        : activeSession.model
          ? [activeSession.model]
          : []
    );
    if (sessionModels.length === 0) {
      return;
    }
    const validModels = modelsLoaded && availableModels.length > 0
      ? sessionModels.filter(model => availableModels.some(item => item.id === model))
      : sessionModels;
    if (validModels.length > 0) {
      setSelectedAgentModels(validModels);
      seededAgentModelsSessionRef.current = activeSession.id;
    }
  }, [
    activeSession.id,
    activeSession.model,
    activeSession.modelsUsed,
    availableModels,
    mode,
    modelsLoaded,
    selectedAgentModels.length,
    setSelectedAgentModels,
  ]);

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
    apiFetch('/api/models')
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

  const sessionLocked = streaming || agentRunning;

  // 在移动端/窄屏时，会话侧栏和 Agent 面板会改变页面主色块区域。
  // 同步 <meta name="theme-color"> 是为了让浏览器地址栏颜色也跟着切换。
  const { resolvedTheme } = useTheme();
  const t = useT();
  useThemeColorSync({ mode, agentMobileTab, showSessions, resolvedTheme });

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

    const restorePendingEvent = event => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'approval_required') {
        approvalRequestRef.current = { ...event, resolve: () => {} };
        setPendingApproval(event);
      } else if (event.type === 'question_required') {
        questionRequestRef.current = { ...event, resolve: () => {} };
        setPendingQuestion(event);
      }
    };

    (async () => {
      try {
        const res = await apiFetch('/api/agent/active', { signal: controller.signal });
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
        restorePendingEvent(data.pendingApproval);
        restorePendingEvent(data.pendingQuestion);

        // 刷新重连时，如果当前会话看起来不是这次 Agent 任务对应的会话，
        // 就临时创建一个“占位会话”承接运行态，避免把其他历史会话的消息替换掉。
        const task = data.task || t('agent.taskFallback');
        const activeRunModels = uniqueModelIds(data.meta?.agentModels);
        const activeRunPrimaryModel = activeRunModels[0] || data.model || undefined;
        setChatState(prev => {
          const cur = prev.sessions.find(s => s.id === prev.activeSessionId);
          const firstUser = cur?.messages?.find(m => m.role === 'user');
          if (firstUser && firstUser.content === task) {
            const sessions = prev.sessions.map(session => {
              if (session.id !== prev.activeSessionId) return session;
              const messages = session.messages.map(message => {
                const isRunUser = message.role === 'user' && message.content === task;
                const isPendingAssistant = message.role === 'assistant' && message.pending === 'run';
                if (!isRunUser && !isPendingAssistant) return message;
                return {
                  ...message,
                  ...(activeRunPrimaryModel && !message.model ? { model: activeRunPrimaryModel } : {}),
                  ...(activeRunModels.length > 0 && !message.modelsUsed ? { modelsUsed: activeRunModels } : {}),
                };
              });
              return touchSession(session, {
                messages,
                ...(activeRunPrimaryModel ? { model: activeRunPrimaryModel } : {}),
                ...(activeRunModels.length > 0 ? { modelsUsed: activeRunModels } : {}),
                agentRunId: data.runId,
              });
            });
            return normalizeChatState({ ...prev, sessions });
          }
          const cleanSession = createSession({
            messages: [
              { role: 'user', content: task, ts: data.startedAt || Date.now(), ...(activeRunPrimaryModel ? { model: activeRunPrimaryModel } : {}), ...(activeRunModels.length > 0 ? { modelsUsed: activeRunModels } : {}) },
              { role: 'assistant', content: t('agent.running'), pending: 'run', ts: Date.now(), ...(activeRunPrimaryModel ? { model: activeRunPrimaryModel } : {}), ...(activeRunModels.length > 0 ? { modelsUsed: activeRunModels } : {}) },
            ],
            model: activeRunPrimaryModel,
            modelsUsed: activeRunModels,
            agentRunId: data.runId,
          });
          return normalizeChatState({
            sessions: [cleanSession, ...prev.sessions],
            activeSessionId: cleanSession.id,
          });
        });

        const response = await apiFetch(`/api/agent/stream/${data.runId}`, { signal: controller.signal });
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
                const metaModels = uniqueModelIds(event.agentModels);
                if (metaModels.length > 0) {
                  updateActiveSession(session => touchSession(session, {
                    model: metaModels[0],
                    modelsUsed: metaModels,
                    agentRunId: event.runId || data.runId,
                  }));
                }
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
                const modelsUsed = uniqueModelIds(event.meta?.models_used);
                const primaryDoneModel = modelsUsed[0] || activeRunPrimaryModel;
                updateActiveSession(session => {
                  const msgs = [...session.messages];
                  const idx = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant' && msgs[i].pending === 'run') return i; } return -1; })();
                  if (idx >= 0) {
                    msgs[idx] = { role: 'assistant', content: event.answer || t('agent.done'), ts: Date.now(), ...(primaryDoneModel ? { model: primaryDoneModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) };
                  } else if (!msgs.some(m => m.role === 'assistant' && m.content === (event.answer || ''))) {
                    msgs.push({ role: 'user', content: reconnectTaskRef.current || data.task || t('agent.taskFallback'), ts: data.startedAt || Date.now(), ...(primaryDoneModel ? { model: primaryDoneModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) });
                    msgs.push({ role: 'assistant', content: event.answer || t('agent.done'), ts: Date.now(), ...(primaryDoneModel ? { model: primaryDoneModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) });
                  }
                  return touchSession(session, {
                    messages: msgs,
                    ...(modelsUsed.length > 0 ? { model: modelsUsed[0], modelsUsed } : {}),
                    agentRunId: data.runId,
                  });
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
        events = await fetchAgentTrace(rid, { projectId: activeSession.projectId ?? null });
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
        ? (terminal.answer || t('agent.done'))
        : t('agent.failed', { error: terminal.error || t('common.unknownError') });
      const modelsUsed = getTraceModels(events);
      const primaryModel = modelsUsed[0] || null;

      setChatState(prev => {
        let changed = false;
        const sessions = prev.sessions.map(session => {
          if (session.agentRunId !== rid) return session;
          const msgs = [...session.messages];
          let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i].role === 'assistant' && msgs[i].pending === 'run') {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            msgs[idx] = { role: 'assistant', content, ts: Date.now(), ...(primaryModel ? { model: primaryModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) };
          } else if (!msgs.some(m => m.role === 'assistant' && m.content === content)) {
            msgs.push({ role: 'assistant', content, ts: Date.now(), ...(primaryModel ? { model: primaryModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) });
          } else {
            return session;
          }
          changed = true;
          return touchSession(session, {
            messages: msgs,
            ...(modelsUsed.length > 0 ? { model: modelsUsed[0], modelsUsed } : {}),
            agentRunId: rid,
          });
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
      fetchAgentTrace(savedRunId, { signal: controller.signal, projectId: activeSession.projectId ?? null })
        .then(events => {
          if (events.length === 0 || controller.signal.aborted) return;
          const deduped = events.filter((e, i) => {
            const key = `${e.type}:${e.step ?? ''}:${e.stage ?? ''}:${e.model ?? ''}`;
            return !events.slice(0, i).some(p => `${p.type}:${p.step ?? ''}:${p.stage ?? ''}:${p.model ?? ''}` === key);
          });
          setAgentTrace(deduped);
          const modelsUsed = getTraceModels(deduped);
          // 重建 trace 只是恢复客户端镜像，不算用户活动：保留原 updatedAt，
          // 否则每次切到/刷新一个 agent 会话都会把它的最近活动时间刷成当前时间。
          updateSession(activeSession.id, session => ({
            ...session,
            agentRunId: savedRunId,
            agentTrace: deduped,
            ...(modelsUsed.length > 0 ? { model: modelsUsed[0], modelsUsed } : {}),
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
    activeProjectId,
  });

  // 切换项目：激活项目并把当前会话切到该项目下最近的一条，没有则新建一条空白会话。
  const handleActivateProject = (projectId) => {
    if (sessionLocked) return;
    Promise.resolve(activateProject(projectId)).catch(() => {});
    setChatState(prev => {
      const inProject = prev.sessions
        .filter(s => (s.projectId ?? null) === (projectId ?? null))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (inProject.length > 0) {
        return normalizeChatState({ ...prev, activeSessionId: inProject[0].id });
      }
      const blank = createSession({ projectId });
      return normalizeChatState({ sessions: [blank, ...prev.sessions], activeSessionId: blank.id });
    });
    setInput('');
    setShowReset(false);
  };

  // 初始加载后把当前会话对齐到后端的激活项目：避免侧边栏按 activeProjectId 过滤、
  // 而打开的对话却属于另一个项目(或旧的 null 会话)导致“切了项目没生效”的错觉。
  // 一次性执行；之后的切换走 handleActivateProject，选择会话只在本项目内。
  const projectsReconciledRef = useRef(false);
  useEffect(() => {
    if (projectsLoading || projectsReconciledRef.current) return;
    projectsReconciledRef.current = true;
    setChatState(prev => {
      const cur = prev.sessions.find(s => s.id === prev.activeSessionId);
      if (cur && (cur.projectId ?? null) === (activeProjectId ?? null)) return prev;
      const inProject = prev.sessions
        .filter(s => (s.projectId ?? null) === (activeProjectId ?? null))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (inProject.length > 0) {
        return normalizeChatState({ ...prev, activeSessionId: inProject[0].id });
      }
      const blank = createSession({ projectId: activeProjectId });
      return normalizeChatState({ sessions: [blank, ...prev.sessions], activeSessionId: blank.id });
    });
  }, [projectsLoading, activeProjectId, setChatState]);

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

  const {
    attachments,
    addFiles: addAttachmentFiles,
    removeAttachment,
    clearAttachments,
    consumeReady: consumeReadyAttachments,
    uploading: attachmentsUploading,
    hasReady: hasReadyAttachments,
  } = useAttachments(activeProjectId);

  const handleSubmit = async () => {
    const userText = input.trim();
    if (!userText && !hasReadyAttachments) {
      return;
    }
    if (sessionLocked) {
      return;
    }
    // agent 模式必须至少选一个模型,否则没有执行目标,直接拦截(UI 上发送按钮也已禁用)。
    if (mode === 'agent' && selectedAgentModels.length === 0) {
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
    const text = buildTaskWithAttachments(userText, readyAttachments, t);
    if (!text) {
      return;
    }

    // 把这次发送累计到后端使用记录,只对 agent 模式做(chat 模式建议少,不需要)
    // 标题用原始用户输入(userText),避免被附件提示污染。
    if (mode === 'agent') {
      const titleSource = userText || readyAttachments[0]?.name || t('attach.taskFallback');
      const title = pendingTitleRef.current
        || (titleSource.length > 12 ? titleSource.slice(0, 12) + '…' : titleSource);
      pendingTitleRef.current = null;
      recordSuggestionUse({ title, text });
      // 下次返回 hero 时能看到新的"最近使用"
      setSuggestionSeed(v => v + 1);
    }

    // 同一输入框根据 mode 分流到两套完全不同的执行链路。
    if (mode === 'agent') {
      await sendAgentTask(text);
      clearAttachments();
      return;
    }

    await sendChatMessage(text);
    clearAttachments();
  };

  const handleKeyDown = e => {
    const isMobile = window.innerWidth < TABLET_BREAKPOINT;
    if (e.key === 'Enter' && e.metaKey && !isMobile) {
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
      // agent 模式一个模型都没选时禁止发送,并给出原因提示。
      blockReason={mode === 'agent' && selectedAgentModels.length === 0 ? t('send.needModel') : ''}
      onSend={handleSubmit}
      onStopGeneration={stopGeneration}
      onStopAgent={stopAgent}
    />
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
    setPendingQuestion,
    questionRequestRef,
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
          locked={sessionLocked}
          showMemoryPanel={showMemoryPanel}
          onToggleMemory={() => setShowMemoryPanel(v => !v)}
          projects={projects}
          activeProjectId={activeProjectId}
          onActivateProject={handleActivateProject}
          onCreateProject={createProject}
          onUpdateProject={updateProject}
          onDeleteProject={deleteProject}
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
        <button className="page-create-btn" onClick={handleCreateSession} disabled={sessionLocked} title={t('header.newSessionTitle')}>
          {t('header.newSession')}
        </button>
      )}
      {showHero && (
        <div className="hero-corner-actions">
          <button className="session-toggle-btn" onClick={() => setShowSessions(v => !v)} title={t('header.sessionList')}>
            <Menu size={16} />
          </button>
          <button className="session-toggle-btn" onClick={() => setShowSettings(true)} title={t('header.settings')}>
            <Settings size={16} />
          </button>
        </div>
      )}
      {showHero ? (
        <HeroScreen
          mode={mode}
          input={input}
          setInput={setInput}
          onKeyDown={handleKeyDown}
          textareaRef={textareaRef}
          sessionLocked={sessionLocked}
          toolbarSlots={{ modeSwitch, modelSelect, sendButton, attachButton }}
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
        />
      ) : (
        <div className="layout">
          {reconnectedRun && agentRunning && (
            <div className="reconnect-banner">
              {t('agent.reconnectBanner')}
            </div>
          )}
          <AppHeader
            sessionTitle={getSessionTitle(messages)}
            sessionLocked={sessionLocked}
            messagesLength={messages.length}
            modeSwitch={modeSwitch}
            modelSelect={modelSelect}
            onToggleSessions={() => setShowSessions(v => !v)}
            onCreateSession={handleCreateSession}
            onReset={() => setShowReset(true)}
            onOpenSettings={() => setShowSettings(true)}
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
              placeholder={mode === 'agent' ? t('input.agentPlaceholder') : t('input.chatPlaceholder')}
              disabled={sessionLocked}
              sendButton={sendButton}
              attachButton={attachButton}
              attachmentBar={attachmentBar}
              touchStartRef={touchStartRef}
              agentMobileTab={agentMobileTab}
              setAgentMobileTab={setAgentMobileTab}
              renderMessageContent={props => <MessageContent {...props} />}
              renderCopyButton={props => <CopyButton {...props} />}
              hasThinkContent={hasThinkContent}
              getModelLabel={modelId => availableModels.find(item => item.id === modelId)?.label || modelId}
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
        onSubmit={handleQuestionSubmit}
        onSkip={handleQuestionSkip}
      />

      {showReset && <ResetDialog onConfirm={handleReset} onCancel={() => setShowReset(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} agentMemory={agentMemory} setAgentMemory={setAgentMemory} />}
    </div>
    </ErrorBoundary>
  );
}
