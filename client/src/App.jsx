import { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Settings, ShieldCheck, Brain } from 'lucide-react';
import './App.css';
import { fetchAgentTrace, parseSseFrame } from './api/streams.js';
import { ensureServiceWorker, notificationPermission, notificationsSupported, requestNotificationPermission } from './notifications.js';
import { AgentWorkspacePane } from './components/AgentWorkspacePane.jsx';
import { SessionSidebar } from './components/SessionSidebar.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { MessageContent } from './components/MessageContent.jsx';
import { CopyButton } from './components/CopyButton.jsx';
import { ToolbarSwitch } from './components/ToolbarSwitch.jsx';
import { ResetDialog } from './components/dialogs/ResetDialog.jsx';
import { ApprovalDialog } from './components/dialogs/ApprovalDialog.jsx';
import { QuestionDialog } from './components/dialogs/QuestionDialog.jsx';
import { SettingsDialog } from './components/dialogs/SettingsDialog.jsx';
import { PromptPreviewDialog } from './components/dialogs/PromptPreviewDialog.jsx';
import { SessionList } from './components/session/SessionList.jsx';
import { AgentPanel } from './components/agent/AgentPanel.jsx';
import { ModelSelector } from './components/ModelSelector.jsx';
import { SendButton } from './components/SendButton.jsx';
import { AttachButton } from './components/AttachButton.jsx';
import { AttachmentBar } from './components/AttachmentBar.jsx';
import { ContextMeter } from './components/ContextMeter.jsx';
import { NotificationBanner } from './components/NotificationBanner.jsx';
import { AppHeader } from './components/AppHeader.jsx';
import { HeroScreen } from './components/HeroScreen.jsx';
import { useAgentRun } from './hooks/useAgentRun.js';
import { createSession, getSessionTitle, normalizeChatState, touchSession, upsertAgentRun, useChatSessions } from './hooks/useChatSessions.js';
import { useProjects } from './hooks/useProjects.js';
import { booleanStorage, usePersistentState, useProjectScopedState } from './hooks/usePersistentState.js';
import { useResponsiveLayout } from './hooks/useResponsiveLayout.js';
import { useThemeColorSync } from './hooks/useThemeColorSync.js';
import { useTheme } from './theme/ThemeProvider.jsx';
import { useT } from './i18n/I18nProvider.jsx';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSessionHandlers } from './hooks/useSessionHandlers.js';
import { useAgentTransport } from './hooks/useAgentTransport.js';
import { useQuestionSubmit } from './hooks/useQuestionSubmit.js';
import { useAttachments } from './hooks/useAttachments.js';
import { EMPTY_SUGGESTIONS } from './data/suggestions.js';
import { fetchSuggestions } from './api/suggestions.js';
import { apiFetch } from './api/http.js';
import {
  TABLET_BREAKPOINT,
  DOCKED_LAYOUT_BREAKPOINT,
  APP_BG_COLOR,
  APP_SURFACE_COLOR,
} from './utils/constants.js';
import { formatMsgTime } from './utils/format.js';
import { shuffled } from './utils/random.js';
import { hasThinkContent } from './utils/markdown.js';
import { appendUniqueTraceEvent, latestTerminalEvent } from './utils/agent-trace.js';
import { buildActualContextEstimate } from './utils/context-usage.js';
import { buildAgentMetaFromSession } from './utils/agent-stats.js';

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
  const [agentPrivateMode, setAgentPrivateMode] = usePersistentState('agent_private_mode', false, booleanStorage);
  const {
    setChatState,
    sessions,
    activeSession,
    messages,
    updateSession,
    preparePrivateMode,
    sessionsLoading,
  } = useChatSessions({ privateMode: agentPrivateMode });
  const {
    projects,
    activeProjectId,
    loading: projectsLoading,
    createProject,
    updateProject,
    deleteProject,
    activateProject,
  } = useProjects();
  const [availableModels, setAvailableModels] = useState([]);
  const agentAvailableModels = useMemo(
    () => availableModels.filter(model => model?.agentCompatible !== false),
    [availableModels]
  );
  // modelsLoaded 用来区分“还没拿到后端列表”和“真实列表为空”，
  // 避免启动阶段误清理用户已选的多模型。
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [contextEstimate, setContextEstimate] = useState(null);
  const mode = 'agent';
  const [suggestionSeed, setSuggestionSeed] = useState(0);
  const [suggestionData, setSuggestionData] = useState(EMPTY_SUGGESTIONS);
  const [activeCategoryId, setActiveCategoryId] = useState(null);
  const {
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
    showScreenshotPanel,
    setShowScreenshotPanel,
    rollbackLoading,
    setRollbackLoading,
    pendingQuestion,
    setPendingQuestion,
    agentStartedAt,
    setAgentStartedAt,
    agentRunIdRef,
    agentAbortRef,
    approvalRequestRef,
    questionRequestRef,
    reconnectTaskRef,
    lastAgentTaskRef,
  } = useAgentRun();
  const [agentMemory, setAgentMemory] = usePersistentState('agent_memory', true, booleanStorage);
  const [showReset, setShowReset] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);
  const [agentActionsHost, setAgentActionsHost] = useState(null);
  const [sidebarPinned, setSidebarPinned] = usePersistentState('session_sidebar_pinned', false, booleanStorage);
  const { showSessions, setShowSessions } = useResponsiveLayout({
    dockedBreakpoint: DOCKED_LAYOUT_BREAKPOINT,
    sidebarPinned,
  });

  useEffect(() => {
    const revealFromLeftEdge = event => {
      if (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT || sidebarPinned) return;
      if (event.clientX <= window.innerWidth * 0.01) setShowSessions(true);
    };
    window.addEventListener('mousemove', revealFromLeftEdge);
    return () => window.removeEventListener('mousemove', revealFromLeftEdge);
  }, [sidebarPinned, setShowSessions]);
  // Agent 的多模型选择与策略「按项目」存储:useProjectScopedState 内部按 activeProjectId 分桶,
  // 切项目时派生值自动跟着变；memory 仍是应用级偏好。
  const [selectedAgentModels, setSelectedAgentModels] = useProjectScopedState('agent_models_by_project', activeProjectId, EMPTY_AGENT_MODELS);
  // Filter out models no longer available
  useEffect(() => {
    if (!modelsLoaded) {
      return;
    }
    // 只有在真正拿到后端模型列表之后才做清理，避免启动阶段误清理本地保存的选择。
    if (selectedAgentModels.length > 0 && availableModels.length > 0) {
      const valid = selectedAgentModels.filter(m => agentAvailableModels.some(avail => avail.id === m));
      if (valid.length !== selectedAgentModels.length) {
        setSelectedAgentModels(valid);
      }
    }
  }, [agentAvailableModels, availableModels.length, modelsLoaded, selectedAgentModels, setSelectedAgentModels]);
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
          const availableIds = new Set(data.models.map(model => model.id));
          // 清理历史会话里已经下线的模型；不再替换成列表第一个模型，避免制造默认选择。
          setChatState(prev => {
            let changed = false;
            const sessions = prev.sessions.map(session => {
              const nextModel = session.model && availableIds.has(session.model) ? session.model : null;
              const nextModelsUsed = uniqueModelIds(session.modelsUsed).filter(model => availableIds.has(model));
              if (nextModel !== (session.model ?? null) || nextModelsUsed.length !== uniqueModelIds(session.modelsUsed).length) {
                changed = true;
                return { ...session, model: nextModel, modelsUsed: nextModelsUsed };
              }
              return session;
            });
            if (!changed) return prev;
            return normalizeChatState({ ...prev, sessions });
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        setModelsLoaded(true);
      });
  }, [setChatState]);

  const sessionLocked = agentRunning;

  // 在移动端/窄屏时，会话侧栏和 Agent 面板会改变页面主色块区域。
  // 同步 <meta name="theme-color"> 是为了让浏览器地址栏颜色也跟着切换。
  const { resolvedTheme } = useTheme();
  const t = useT();
  const sessionTitle = useMemo(() => getSessionTitle(messages), [messages]);
  useThemeColorSync({ showSessions, resolvedTheme });

  useEffect(() => {
    const normalTitle = messages.length > 0 && sessionTitle
      ? `${sessionTitle} · sagent`
      : 'sagent';
    document.title = agentRunning
      ? `${agentStopping ? t('agentPanel.stopping') : t('agentPanel.running')} · ${sessionTitle || 'sagent'}`
      : normalTitle;
    return () => { document.title = 'sagent'; };
  }, [agentRunning, agentStopping, messages.length, sessionTitle, t]);

  // 页面刷新后，如果后端还有运行中的 agent，这里会尝试“接回去”：
  // 1. 先查 /api/agent/active
  // 2. 再订阅 /api/agent/stream/:runId
  // 3. 同时把 UI 切回 Agent 模式，并用占位消息保住聊天视图连续性
  useEffect(() => {
    if (sessionsLoading) return undefined;
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

        // 后端 run 元数据是隐私状态的权威来源。先冻结当前普通会话，再切换开关，
        // 避免下面的重连占位消息被误当成“进入隐私前状态”并在退出后补写。
        if (data.meta?.privateMode === true) {
          preparePrivateMode();
          setAgentPrivateMode(true);
        }
        setAgentRunning(true);
        setAgentTrace([]);
        setReconnectedRun(true);
        setAgentStartedAt(data.startedAt || null);
        setAgentRunId(data.runId);
        agentRunIdRef.current = data.runId;
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
                agentMeta: null,
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

        const response = await apiFetch(`/api/agent/stream/${encodeURIComponent(data.runId)}?cursor=0${data.meta?.projectId ? `&projectId=${encodeURIComponent(data.meta.projectId)}` : ''}`, { signal: controller.signal });
        if (!response.ok || aborted) {
          setAgentRunning(false);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // cursor=0 会回放整条 trace，其中包含此前失败 attempt 的 done/error。
        // 那些只是历史，不能用来结束当前运行态——否则刚接回的 run 会立刻被
        // 旧 attempt 的 error 打回“已结束”，占位消息还会被写成失败。
        // 以 run 当前 attempt 为界；重连期间真的又开一次 attempt 时同步抬高。
        let liveAttempt = Number.isInteger(data.meta?.attempt) && data.meta.attempt > 0
          ? data.meta.attempt
          : 1;
        const isReplayedTerminal = event => {
          const attempt = Number(event?.attempt);
          return Number.isInteger(attempt) && attempt > 0 && attempt < liveAttempt;
        };

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            try {
              const event = parseSseFrame(line);
              if (!event) continue;

              if (event.type === 'run_meta') {
                // 回放里每个 attempt 都有一条 run_meta，据此把界推到最新一次重试。
                const metaAttempt = Number(event.attempt);
                if (Number.isInteger(metaAttempt) && metaAttempt > liveAttempt) {
                  liveAttempt = metaAttempt;
                }
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
                return appendUniqueTraceEvent(prev, event);
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
                if (isReplayedTerminal(event)) continue;
                setAgentRunning(false);
                const modelsUsed = uniqueModelIds(event.meta?.models_used);
                const primaryDoneModel = modelsUsed[0] || activeRunPrimaryModel;
                setAgentTrace(prevTrace => {
                  const nextTrace = appendUniqueTraceEvent(prevTrace, event);
                  updateActiveSession(session => {
                    const msgs = [...session.messages];
                    const idx = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant' && msgs[i].pending === 'run') return i; } return -1; })();
                    if (idx >= 0) {
                      msgs[idx] = { role: 'assistant', content: event.answer || t('agent.done'), ts: Date.now(), ...(primaryDoneModel ? { model: primaryDoneModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) };
                    } else if (!msgs.some(m => m.role === 'assistant' && m.content === (event.answer || ''))) {
                      msgs.push({ role: 'user', content: reconnectTaskRef.current || data.task || t('agent.taskFallback'), ts: data.startedAt || Date.now(), ...(primaryDoneModel ? { model: primaryDoneModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) });
                      msgs.push({ role: 'assistant', content: event.answer || t('agent.done'), ts: Date.now(), ...(primaryDoneModel ? { model: primaryDoneModel } : {}), ...(modelsUsed.length > 0 ? { modelsUsed } : {}) });
                    }
                    const nextSession = {
                      ...session,
                      messages: msgs,
                      ...(modelsUsed.length > 0 ? { model: modelsUsed[0], modelsUsed } : {}),
                      agentRunId: data.runId,
                      agentTrace: nextTrace,
                    };
                    const agentMeta = buildAgentMetaFromSession(nextSession, nextTrace, {
                      task: reconnectTaskRef.current || data.task || t('agent.taskFallback'),
                      startedAt: data.startedAt,
                      models: modelsUsed,
                      status: event.quality?.status || event.meta?.status || 'done',
                      runId: data.runId,
                    });
                    return touchSession(upsertAgentRun({
                      ...nextSession,
                      agentMeta,
                    }, {
                      runId: data.runId,
                      trace: nextTrace,
                      meta: agentMeta,
                    }));
                  });
                  return nextTrace;
                });
              }

              if (event.type === 'error') {
                if (isReplayedTerminal(event)) continue;
                setAgentRunning(false);
                setAgentTrace(prevTrace => {
                  const nextTrace = appendUniqueTraceEvent(prevTrace, event);
                  updateActiveSession(session => {
                    const msgs = [...session.messages];
                    const idx = (() => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant' && msgs[i].pending === 'run') return i; } return -1; })();
                    const content = t('agent.failed', { error: event.error || t('common.unknownError') });
                    if (idx >= 0) {
                      msgs[idx] = { role: 'assistant', content, ts: Date.now(), ...(activeRunPrimaryModel ? { model: activeRunPrimaryModel } : {}), ...(activeRunModels.length > 0 ? { modelsUsed: activeRunModels } : {}) };
                    } else if (!msgs.some(m => m.role === 'assistant' && m.content === content)) {
                      msgs.push({ role: 'assistant', content, ts: Date.now(), ...(activeRunPrimaryModel ? { model: activeRunPrimaryModel } : {}), ...(activeRunModels.length > 0 ? { modelsUsed: activeRunModels } : {}) });
                    }
                    const nextSession = {
                      ...session,
                      messages: msgs,
                      ...(activeRunPrimaryModel ? { model: activeRunPrimaryModel } : {}),
                      ...(activeRunModels.length > 0 ? { modelsUsed: activeRunModels } : {}),
                      agentRunId: data.runId,
                      agentTrace: nextTrace,
                    };
                    const agentMeta = buildAgentMetaFromSession(nextSession, nextTrace, {
                      task: reconnectTaskRef.current || data.task || t('agent.taskFallback'),
                      startedAt: data.startedAt,
                      models: activeRunModels,
                      status: event.error === 'Agent 已取消' ? 'cancelled' : 'error',
                      runId: data.runId,
                    });
                    return touchSession(upsertAgentRun({
                      ...nextSession,
                      agentMeta,
                    }, {
                      runId: data.runId,
                      trace: nextTrace,
                      meta: agentMeta,
                    }));
                  });
                  return nextTrace;
                });
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
  }, [sessionsLoading]);

  // 手机后台/切 tab 时浏览器会冻结 JS、节流网络，SSE reader 可能在后台错过
  // done/error 事件。普通 run 切回前台时可用持久化 trace 兜底；隐私 run 没有
  // 磁盘 trace，只依赖当前 SSE/内存链路。
  useEffect(() => {
    if (!agentRunning || agentPrivateMode) return;
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

      // 重试会把多个 attempt 的 done/error 都留在同一条 trace 里，取首个会读到
      // 早已被重跑覆盖的旧结果——成功的 run 因此被记成失败。
      const terminal = latestTerminalEvent(events);
      if (!terminal) return;

      setAgentTrace(prev => appendUniqueTraceEvent(prev, terminal));

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
          }
          changed = true;
          const nextSession = {
            ...session,
            messages: msgs,
            ...(modelsUsed.length > 0 ? { model: modelsUsed[0], modelsUsed } : {}),
            agentRunId: rid,
            agentTrace: events,
          };
          const agentMeta = buildAgentMetaFromSession(nextSession, events, {
            task: lastAgentTaskRef.current || undefined,
            models: modelsUsed,
            status: terminal.type === 'done' ? (terminal.quality?.status || terminal.meta?.status || 'done') : (terminal.error === 'Agent 已取消' ? 'cancelled' : 'error'),
            runId: rid,
          });
          return touchSession(upsertAgentRun({
            ...nextSession,
            agentMeta,
          }, {
            runId: rid,
            trace: events,
            meta: agentMeta,
          }));
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
  }, [agentPrivateMode, agentRunning]);

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
          const deduped = events.reduce((acc, event) => appendUniqueTraceEvent(acc, event), []);
          setAgentTrace(deduped);
          const modelsUsed = getTraceModels(deduped);
          // 重建 trace 只是恢复客户端镜像，不算用户活动：保留原 updatedAt，
          // 否则每次切到/刷新一个 agent 会话都会把它的最近活动时间刷成当前时间。
          updateSession(activeSession.id, session => {
            const nextSession = {
              ...session,
              agentRunId: savedRunId,
              agentTrace: deduped,
              ...(modelsUsed.length > 0 ? { model: modelsUsed[0], modelsUsed } : {}),
            };
            const agentMeta = buildAgentMetaFromSession(nextSession, deduped);
            return upsertAgentRun({
              ...nextSession,
              agentMeta,
            }, {
              runId: savedRunId,
              trace: deduped,
              meta: agentMeta,
            });
          });
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

  // 建议数据从后端拉取；换一组只改变本地随机种子。
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
  }, []);

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
      // 页面卸载时中止 Agent 网络流，也顺手拒绝掉所有等待中的审批 Promise，避免悬挂。
      agentAbortRef.current?.abort();
      approvalRequestRef.current?.resolve?.('reject');
    };
  }, [agentAbortRef, approvalRequestRef]);

  const {
    handleCreateSession,
    handleSelectSession,
    handleArchiveSession,
    handleRestoreSession,
    handleDeleteArchivedSession,
    handleReset,
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
        .filter(s => !s.archivedAt && (s.projectId ?? null) === (projectId ?? null))
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
    if (projectsLoading || sessionsLoading || projectsReconciledRef.current) return;
    projectsReconciledRef.current = true;
    setChatState(prev => {
      const cur = prev.sessions.find(s => s.id === prev.activeSessionId);
      if (cur && !cur.archivedAt && (cur.projectId ?? null) === (activeProjectId ?? null)) return prev;
      const inProject = prev.sessions
        .filter(s => !s.archivedAt && (s.projectId ?? null) === (activeProjectId ?? null))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (inProject.length > 0) {
        return normalizeChatState({ ...prev, activeSessionId: inProject[0].id });
      }
      const blank = createSession({ projectId: activeProjectId });
      return normalizeChatState({ sessions: [blank, ...prev.sessions], activeSessionId: blank.id });
    });
  }, [projectsLoading, sessionsLoading, activeProjectId, setChatState]);

  const { sendAgentTask, stopAgent, handleRollback, handleApprovalDecision } = useAgentTransport({
    activeSession,
    messages,
    agentTrace,
    agentRunning,
    selectedAgentModels,
    agentStrategy,
    agentMemory,
    agentPrivateMode,
    availableModels: agentAvailableModels,
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
    // Agent 必须至少选一个模型,否则没有执行目标,直接拦截(UI 上发送按钮也已禁用)。
    if (selectedAgentModels.length === 0) {
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

    await sendAgentTask(text);
    clearAttachments();
  };

  const handleKeyDown = e => {
    const isMobile = window.innerWidth < TABLET_BREAKPOINT;
    const submitModifier = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && submitModifier && !isMobile) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const agentCategories = suggestionData.agent;

  const suggestions = useMemo(() => {
    void activeSession.id;
    void suggestionSeed;
    const cat = agentCategories.find(c => c.id === activeCategoryId) ?? agentCategories[0];
    const pool = cat?.items ?? [];
    return shuffled(pool).slice(0, Math.min(8, pool.length));
  }, [activeSession.id, suggestionSeed, activeCategoryId, agentCategories]);

  const recentModelUsage = useMemo(() => {
    const usage = {};
    for (const session of sessions) {
      const timestamp = Number(session.updatedAt || session.createdAt) || 0;
      const modelIds = uniqueModelIds([session.model, ...(Array.isArray(session.modelsUsed) ? session.modelsUsed : [])]);
      for (const modelId of modelIds) {
        usage[modelId] = Math.max(usage[modelId] || 0, timestamp);
      }
    }
    return usage;
  }, [sessions]);

  // 工具栏元素集中构造，再传给 hero/workspace 两种布局；两处共享同一套状态和行为。
  const modelSelect = (
    <ModelSelector
      availableModels={agentAvailableModels}
      selectedAgentModels={selectedAgentModels}
      setSelectedAgentModels={setSelectedAgentModels}
      agentStrategy={agentStrategy}
      setAgentStrategy={setAgentStrategy}
      sessionLocked={sessionLocked}
      recentModelUsage={recentModelUsage}
    />
  );
  const contextInputText = useMemo(
    () => buildTaskWithAttachments(input, attachments.filter(item => item.status === 'ready'), t),
    [attachments, input, t]
  );

  useEffect(() => {
    if (selectedAgentModels.length === 0) {
      setContextEstimate(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiFetch('/api/agent/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          task: contextInputText,
          model: selectedAgentModels[0],
          models: selectedAgentModels,
          strategy: selectedAgentModels.length > 1 ? agentStrategy : 'race',
          memory: agentMemory,
          projectId: activeProjectId ?? null,
          messages: messages.slice(-10).map(message => ({ role: message.role, content: message.content })),
        }),
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (!controller.signal.aborted) setContextEstimate(data);
        })
        .catch(err => {
          if (err?.name !== 'AbortError') setContextEstimate(null);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeProjectId, agentMemory, agentStrategy, contextInputText, messages, selectedAgentModels]);

  const actualContextEstimate = useMemo(
    () => buildActualContextEstimate(agentTrace, contextEstimate),
    [agentTrace, contextEstimate]
  );
  const visibleContextEstimate = agentRunning && actualContextEstimate
    ? actualContextEstimate
    : contextEstimate;
  const contextMeter = (
    <ContextMeter
      estimate={visibleContextEstimate}
      onOpenPrompt={() => setShowPromptPreview(true)}
    />
  );
  const sendButton = (
    <SendButton
      agentRunning={agentRunning}
      agentStopping={agentStopping}
      pendingApproval={pendingApproval}
      // 输入栏要有正文 *或* 已就绪附件才能发送;上传中按钮也置灰。
      inputValue={attachmentsUploading ? '' : (input || (hasReadyAttachments ? ' ' : ''))}
      // 一个模型都没选时禁止发送,并给出原因提示。
      blockReason={selectedAgentModels.length === 0 ? t('send.needModel') : ''}
      contextEstimate={visibleContextEstimate}
      onSend={handleSubmit}
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
  const privateModeToggle = (
    // 这是 run 级开关；运行中锁定，避免同一 run 中途改变持久化策略。
    <ToolbarSwitch
      icon={<ShieldCheck size={14} strokeWidth={2} />}
      label={t('input.privateMode')}
      checked={agentPrivateMode}
      onChange={next => {
        if (next) preparePrivateMode();
        setAgentPrivateMode(next);
      }}
      disabled={sessionLocked}
      title={t(agentPrivateMode ? 'input.privateModeOn' : 'input.privateModeOff')}
    />
  );
  const memoryToggle = (
    // 记忆是前端偏好，立即生效于下一次任务，因此运行中也允许改。
    <ToolbarSwitch
      icon={<Brain size={14} strokeWidth={2} />}
      label={t('input.memory')}
      checked={agentMemory}
      onChange={setAgentMemory}
      title={t(agentMemory ? 'input.memoryOn' : 'input.memoryOff')}
    />
  );
  const attachmentBar = (
    <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
  );

  const showHero = messages.length === 0 && !agentRunning;
  const activeAgentMeta = useMemo(
    () => buildAgentMetaFromSession(activeSession, agentTrace),
    [activeSession, agentTrace]
  );

  const { submitting: questionSubmitting, handleSubmit: handleQuestionSubmit, handleSkip: handleQuestionSkip } = useQuestionSubmit({
    pendingQuestion,
    setPendingQuestion,
    questionRequestRef,
  });

  return (
    <ErrorBoundary>
    <div className="app-shell">
      <SessionSidebar open={showSessions} pinned={sidebarPinned} onClose={() => setShowSessions(false)}>
        <SessionList
          sessions={sessions}
          activeSessionId={activeSession.id}
          modelList={availableModels}
          onArchive={handleArchiveSession}
          onRestore={handleRestoreSession}
          onDeleteArchived={handleDeleteArchivedSession}
          onSelect={(id) => { handleSelectSession(id); if (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT) setShowSessions(false); }}
          locked={sessionLocked}
          showMemoryPanel={showMemoryPanel}
          onToggleMemory={() => setShowMemoryPanel(v => !v)}
          showScreenshotPanel={showScreenshotPanel}
          onToggleScreenshots={() => setShowScreenshotPanel(v => !v)}
          sidebarPinned={sidebarPinned}
          onToggleSidebarPin={() => {
            const nextPinned = !sidebarPinned;
            setSidebarPinned(nextPinned);
            setShowSessions(nextPinned);
          }}
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
          <button className="session-toggle-btn" onClick={() => sidebarPinned ? setSidebarPinned(false) : setShowSessions(v => !v)} title={t('header.sessionList')}>
            <Menu size={16} />
          </button>
          <button className="session-toggle-btn" onClick={() => setShowSettings(true)} title={t('header.settings')}>
            <Settings size={16} />
          </button>
        </div>
      )}
      {showHero ? (
        <HeroScreen
          input={input}
          setInput={setInput}
          onKeyDown={handleKeyDown}
          textareaRef={textareaRef}
          sessionLocked={sessionLocked}
          toolbarSlots={{ modelSelect, sendButton, attachButton, privateModeToggle, memoryToggle }}
          attachmentBar={attachmentBar}
          contextMeter={contextMeter}
          suggestions={suggestions}
          categories={agentCategories}
          activeCategoryId={activeCategoryId}
          onSelectCategory={setActiveCategoryId}
          onShuffle={() => setSuggestionSeed(v => v + 1)}
          onPickSuggestion={(text) => {
            setInput(text);
            textareaRef.current?.focus();
          }}
          onSubmitSuggestion={(text) => {
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
            sessionTitle={sessionTitle}
            sessionLocked={sessionLocked}
            messagesLength={messages.length}
            agentActionsHostRef={setAgentActionsHost}
            onToggleSessions={() => sidebarPinned ? setSidebarPinned(false) : setShowSessions(v => !v)}
            onCreateSession={handleCreateSession}
            onReset={() => setShowReset(true)}
            onOpenSettings={() => setShowSettings(true)}
          />

          <div className="layout-body">
            <AgentWorkspacePane
              messages={messages}
              agentPanel={(agentRunning || agentTrace.length > 0 || activeAgentMeta) ? (
                <AgentPanel
                  running={agentRunning}
                  trace={agentTrace}
                  startedAt={agentStartedAt}
                  lastRun={activeAgentMeta}
                  previousRuns={activeSession.agentRuns || []}
                  projectId={activeSession.projectId ?? null}
                  modelList={availableModels}
                  collapsed={agentCollapsed}
                  onToggleCollapse={() => setAgentCollapsed(c => !c)}
                  onStop={stopAgent}
                  agentStopping={agentStopping}
                  pendingApproval={pendingApproval}
                  onRollback={handleRollback}
                  rollbackLoading={rollbackLoading}
                  headerActionsHost={agentActionsHost}
                />
              ) : null}
              streaming={false}
              bottomRef={bottomRef}
              textareaRef={textareaRef}
              inputValue={input}
              setInput={setInput}
              handleKeyDown={handleKeyDown}
              placeholder={t('input.agentPlaceholder')}
              disabled={sessionLocked}
              sendButton={sendButton}
              modelSelect={modelSelect}
              attachButton={attachButton}
              privateModeToggle={privateModeToggle}
              memoryToggle={memoryToggle}
              attachmentBar={attachmentBar}
              contextMeter={contextMeter}
              renderMessageContent={props => <MessageContent {...props} projectId={activeSession?.projectId ?? null} />}
              renderCopyButton={props => <CopyButton {...props} />}
              hasThinkContent={hasThinkContent}
              getModelLabel={modelId => availableModels.find(item => item.id === modelId)?.label || modelId}
              formatMsgTime={formatMsgTime}
            />

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
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} activeProjectId={activeProjectId} projects={projects} />}
      {showPromptPreview && visibleContextEstimate?.promptPreview?.text && (
        <PromptPreviewDialog
          estimate={visibleContextEstimate}
          onClose={() => setShowPromptPreview(false)}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}
