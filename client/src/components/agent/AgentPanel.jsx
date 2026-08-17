import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Square, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp,
  Monitor, Loader2, Bot, Clock3, Coins, ListChecks, Trophy, History, Activity, Eye, EyeOff,
} from 'lucide-react';
import { PHONE_BREAKPOINT } from '../../utils/constants.js';
import { ModelPlanGroup } from './ModelPlanGroup.jsx';
import { ElapsedTimer } from './ElapsedTimer.jsx';
import { TraceItem } from './TraceItem.jsx';
import { StepCard } from './StepCard.jsx';
import { computeTraceMetrics, formatDurationMs, formatTokenCount, traceModelIds } from './trace-metrics.js';
import { getModelLabel } from './plan-stage.js';
import { TraceDebugPanel } from './TraceDebugPanel.jsx';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { usePersistentState, jsonStorage } from '../../hooks/usePersistentState.js';
import { MAX_AGENT_RUN_HISTORY } from '../../hooks/useChatSessions.js';
import { useT } from '../../i18n/I18nProvider.jsx';
import { formatFullTime, formatRelativeTime } from '../../utils/format.js';
import { fetchAgentTrace } from '../../api/streams.js';
import { dedupeTraceEvents } from '../../utils/agent-trace.js';
import { DialogShell } from '../dialogs/DialogShell.jsx';
import { attemptStepKey, buildAttemptTraceIndex } from '../../utils/agent-attempts.js';

// 运行悬浮框的位置/尺寸持久化 key(全局，不分项目)。
const FLOAT_BOX_KEY = 'sagent.agentFloatBox';

// AgentPanel 既是执行面板，也是运行时仪表盘：
// - 负责展示 trace
// - 负责显示暂停/审批/用时/token 等运行态指标
// - 在移动端和桌面端之间复用同一套事件展示逻辑
function strategyLabel(strategy, t) {
  if (strategy === 'vote') return t('agentStats.strategyVote');
  return t('agentStats.strategyRace');
}

function statusLabel(status, t) {
  if (status === 'done_degraded') return t('agentStats.statusDegraded');
  if (status === 'done_unverified') return t('agentStats.statusUnverified');
  if (status === 'error') return t('agentStats.statusError');
  if (status === 'cancelled') return t('agentStats.statusCancelled');
  return t('agentStats.statusDone');
}

// 状态标签的配色分档，对应 App.css 里的 --c-badge-* 令牌(自带暗色变体)。
// 缺省归到 done：老会话的 agentMeta 可能没有 status，但它们本来就是跑完的。
function statusTone(status) {
  if (status === 'error') return 'error';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'done_degraded') return 'degraded';
  if (status === 'done_unverified') return 'unverified';
  return 'done';
}

function traceRunId(trace) {
  if (!Array.isArray(trace)) return null;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const runId = trace[i]?.runId;
    if (typeof runId === 'string' && runId) return runId;
  }
  return null;
}

function runKey(run, index = 0) {
  return run?.runId || run?.meta?.runId || `${run?.meta?.startedAt || ''}:${run?.meta?.task || ''}:${index}`;
}

function shouldHideTimelineEvent(event) {
  if (event.type === 'run_meta') return true;
  if (event.type === 'session_checkpoint') return true;
  if (event.type === 'browser_session' && !['recovering', 'degraded'].includes(event.status)) return true;
  return event.type === 'status' && (event.status === 'starting' || event.status === 'browser_ready');
}

function AgentTraceTimeline({
  trace,
  running,
  modelList,
  cardsExpanded,
  onManualToggle,
  onRollback,
  rollbackLoading,
  openLightbox,
  t,
  bottomRef = null,
  history = false,
  selectedModelId = 'all',
}) {
  const metrics = useMemo(() => computeTraceMetrics(trace), [trace]);
  const attemptIndex = useMemo(() => buildAttemptTraceIndex(trace), [trace]);
  const {
    entries,
    eventsByStep,
    firstEventIndexByAttempt,
    observeAnchorIndexByStep,
    planAnchorIndexByStep,
    previousRequestByIndex,
    previousRequestByEvent,
    previousRequestsByAnchorIndex,
    singleModelSteps,
    multiModelSteps,
    terminalAttempts,
    latestAttempt,
  } = attemptIndex;

  return (
    <div className={`agent-trace${history ? ' agent-trace--history' : ''}`}>
      {entries.map(({ event, index, attempt }) => {
        const stepKey = event.step == null ? null : attemptStepKey(attempt, event.step);
        const stepEvents = stepKey ? (eventsByStep.get(stepKey) || []) : [];
        const stepModelEvent = stepEvents.find(e => e.type === 'model_plan' && (e.stage === 'success' || e.stage === 'winner'));
        // 「上一轮请求」在索引阶段已按各模型自己的时间线算好，这里只做查表，
        // 不在渲染过程中累积状态——那样会让读取时机决定读到的值。
        // model_plan 事件按自身下标取；非 model_plan（单模型步骤渲染在 step 事件上）
        // 只能拿到同 step 的 model_plan 事件对象，故按事件身份取。
        const previousRequest = event.type === 'model_plan'
          ? (previousRequestByIndex.get(index) ?? null)
          : (stepModelEvent ? (previousRequestByEvent.get(stepModelEvent) ?? null) : null);
        const groupedOutput = (event.type === 'terminal_output' || event.type === 'mcp_output')
          && (singleModelSteps.has(stepKey) || multiModelSteps.has(stepKey));
        const showAttemptBoundary = attempt > 1 && firstEventIndexByAttempt.get(attempt) === index;
        let content = null;

        if (!shouldHideTimelineEvent(event) && event.type === 'model_plan') {
          if (event.stage === 'start' && event.models?.length > 1 && planAnchorIndexByStep.get(stepKey) === index) {
            content = (
              <ModelPlanGroup
                key={`model-plan-attempt-${attempt}-step-${event.step ?? index}`}
                events={stepEvents}
                step={event.step}
                models={event.models}
                previousRequests={previousRequestsByAnchorIndex.get(index)}
                selectedModelId={selectedModelId}
                modelList={modelList}
                agentFinished={attempt < latestAttempt || terminalAttempts.has(attempt) || (!running && attempt === latestAttempt)}
                cardsExpanded={cardsExpanded}
                onManualToggle={onManualToggle}
                onRollback={onRollback}
                rollbackLoading={rollbackLoading}
                openLightbox={openLightbox}
              />
            );
          } else if (event.stage === 'consensus') {
            content = (
              <TraceItem
                key={`consensus-attempt-${attempt}-${event.step ?? index}-${index}`}
                event={event}
                selectedModelId={selectedModelId}
                modelList={modelList}
                onRollback={onRollback}
                rollbackLoading={rollbackLoading}
                openLightbox={openLightbox}
                t={t}
              />
            );
          }
        } else if (!shouldHideTimelineEvent(event) && event.type === 'step') {
          if (singleModelSteps.has(stepKey)) {
            const startEvent = stepEvents.find(e => e.type === 'model_plan' && e.stage === 'start');
            if ((selectedModelId === 'all' || startEvent?.models?.includes(selectedModelId))
              && event.stage === 'observe'
              && observeAnchorIndexByStep.get(stepKey) === index) {
              content = (
                <StepCard
                  key={`step-card-attempt-${attempt}-step-${event.step ?? index}`}
                  events={stepEvents}
                  step={event.step}
                  active={running && attempt === latestAttempt && event.step === metrics.lastStep}
                  modelList={modelList}
                  previousRequest={previousRequest}
                  onRollback={onRollback}
                  rollbackLoading={rollbackLoading}
                  openLightbox={openLightbox}
                  forceExpanded={cardsExpanded}
                  onManualToggle={onManualToggle}
                  t={t}
                />
              );
            }
          } else if (!multiModelSteps.has(stepKey)) {
            content = (
              <TraceItem
                key={`${event.type}-attempt-${attempt}-${event.step ?? index}-${event.stage ?? index}-${index}`}
                event={event}
                selectedModelId={selectedModelId}
                modelList={modelList}
                onRollback={onRollback}
                rollbackLoading={rollbackLoading}
                openLightbox={openLightbox}
                t={t}
              />
            );
          }
        } else if (!shouldHideTimelineEvent(event) && !groupedOutput) {
          content = (
            <TraceItem
              key={`${event.type}-attempt-${attempt}-${event.step ?? index}-${event.stage ?? index}-${index}`}
              event={event}
              selectedModelId={selectedModelId}
              modelList={modelList}
              onRollback={onRollback}
              rollbackLoading={rollbackLoading}
              openLightbox={openLightbox}
              t={t}
            />
          );
        }

        if (!showAttemptBoundary) return content;
        return (
          <Fragment key={`attempt-boundary-${attempt}-${index}`}>
            <div className="agent-attempt-boundary" data-attempt={attempt}>
              <span>{t('agentPanel.retryAttempt', { attempt })}</span>
            </div>
            {content}
          </Fragment>
        );
      })}
      {bottomRef && <div ref={bottomRef} />}
    </div>
  );
}

export function AgentPanel({ running, trace, startedAt, lastRun, previousRuns = [], projectId = null, modelList, collapsed, onToggleCollapse, onStop, agentStopping, pendingApproval, onRollback, rollbackLoading, headerActionsHost = null }) {
  const t = useT();
  const traceBottomRef = useRef(null);
  const traceStickyRef = useRef(true);
  const isMobile = useIsMobile(PHONE_BREAKPOINT);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [cardsExpanded, setCardsExpanded] = useState(null); // null=auto, true=all open, false=all closed
  const [expandedHistoryRun, setExpandedHistoryRun] = useState(null);
  const [historyTraceCache, setHistoryTraceCache] = useState({});
  const [historyTraceLoading, setHistoryTraceLoading] = useState(null);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [traceDebugOpen, setTraceDebugOpen] = useState(false);
  const [traceDebugModelId, setTraceDebugModelId] = useState('all');
  const [headVisible, setHeadVisible] = useState(true);
  // 展开着完整步骤流的那一轮 run(按 runId 记，不是布尔量)：
  // 只有“本次进来跑过的这一轮”默认展开，点开历史会话时一律先折叠成摘要卡。
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [selectedModelId, setSelectedModelId] = useState('all');

  // 运行悬浮框：默认贴在页面右上角(fixed，见 CSS)，桌面端可拖动、缩放；位置尺寸持久化。
  // 交互过程中走临时 liveBox(纯内存)，松手才写入 storedBox(落 localStorage)，避免每帧写盘。
  const headRef = useRef(null);
  const gestureOrigin = useRef(null);
  const liveBoxRef = useRef(null);
  const movedRef = useRef(false);
  const [storedBox, setStoredBox] = usePersistentState(FLOAT_BOX_KEY, null, jsonStorage);
  const [liveBox, setLiveBox] = useState(null);
  const [gesture, setGesture] = useState(null); // 'drag' | 'resize' | null
  const box = liveBox ?? storedBox; // 生效布局 {left, top, width, height}，字段可缺省
  const storedBoxRef = useRef(storedBox);
  useEffect(() => { storedBoxRef.current = storedBox; }, [storedBox]);

  // onRollback 来自上层且每次 render 是新引用；用 ref 包出稳定回调，
  // 这样 memo 化的 TraceItem 不会因为回调引用变化而整片重渲。
  const rollbackRef = useRef(onRollback);
  useEffect(() => { rollbackRef.current = onRollback; }, [onRollback]);
  const stableRollback = useCallback(step => rollbackRef.current?.(step), []);
  const disabledRollback = useCallback(() => {}, []);

  // 记录手势起点(指针坐标 + 当前框的视口矩形 + 是否已有显式宽高)。
  const captureOrigin = useCallback(e => {
    const rect = headRef.current?.getBoundingClientRect();
    if (!rect) return false;
    gestureOrigin.current = {
      px: e.clientX, py: e.clientY,
      left: rect.left, top: rect.top, w: rect.width, h: rect.height,
      hasWidth: box?.width != null, hasHeight: box?.height != null,
    };
    return true;
  }, [box]);

  // 从悬浮框标题栏空白处按下即开始拖动；点在按钮/链接/缩放手柄上不触发。
  const beginHeadDrag = useCallback(e => {
    if (isMobile) return;
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest?.('button, a, input, textarea, select, [role="button"], .agent-panel-head-resize')) return;
    if (!captureOrigin(e)) return;
    movedRef.current = false;
    setGesture('drag');
  }, [isMobile, captureOrigin]);

  // 左下角手柄按下开始缩放；阻止冒泡以免同时触发拖动。
  const beginHeadResize = useCallback(e => {
    if (isMobile) return;
    if (e.button != null && e.button !== 0) return;
    e.stopPropagation();
    if (!captureOrigin(e)) return;
    setGesture('resize');
  }, [isMobile, captureOrigin]);

  // 折叠态下点击标题栏展开；若刚拖动过则跳过这次点击。
  const handleHeadClick = useCallback(() => {
    if (movedRef.current) { movedRef.current = false; return; }
    onToggleCollapse?.();
  }, [onToggleCollapse]);

  // 以下派生值原先每次 render（含每秒计时 tick）都对整条 trace 做 some/reduce/find，
  // 现在统一 memo 化，只在 trace/running 变化时重算。
  const metrics = useMemo(() => computeTraceMetrics(trace), [trace]);
  const browserHealth = useMemo(() => {
    const events = trace.filter(event => event.type === 'browser_session' || (event.type === 'status' && event.status === 'browser_ready'));
    const latest = events.at(-1);
    if (!latest) return null;
    const latestPreview = events.findLast(event => event.screenshotUrl);
    const recoveries = events.filter(event => event.type === 'browser_session' && event.status === 'recovering').length;
    return {
      ...latestPreview,
      ...latest,
      screenshotUrl: latest.screenshotUrl || latestPreview?.screenshotUrl || null,
      title: latest.title || latestPreview?.title || '',
      url: latest.url || latestPreview?.url || '',
      status: latest.status === 'browser_ready' ? 'ready' : latest.status,
      recoveries,
    };
  }, [trace]);
  const modelIds = useMemo(() => traceModelIds(trace), [trace]);
  const hasModelCards = useMemo(
    () => trace.some(e => e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 0),
    [trace],
  );
  const doneEvent = useMemo(() => trace.find(e => e.type === 'done'), [trace]);
  // Detect if waiting for user question
  const hasPendingQuestion = useMemo(
    () => running && trace.some(e => e.type === 'question_required') && !trace.some(e => e.type === 'user_response'),
    [running, trace],
  );

  const doneMeta = doneEvent?.meta || {};
  const doneStatus = doneEvent?.quality?.status || doneMeta.status || 'done';
  const doneStatusLabel = doneStatus === 'done_unverified'
    ? t('agentPanel.statusUnverified')
    : doneStatus === 'done_degraded'
      ? t('agentPanel.statusDegraded')
      : t('agentPanel.statusDone');
  const headerTitle = running
    ? t('agentPanel.running')
    : doneEvent
      ? doneStatusLabel
      : t('agentPanel.lastRun');
  const headerStatus = running ? 'running' : doneEvent ? 'complete' : 'idle';
  const headerStepCount = running ? metrics.lastStep : (doneMeta.step_count || metrics.lastStep);
  const allCardsExpanded = cardsExpanded === true;
  const lastRunModels = useMemo(
    () => (lastRun?.models || []).map(model => modelList.find(item => item.id === model)?.label || model),
    [lastRun, modelList],
  );
  const currentRunId = lastRun?.runId || traceRunId(trace);
  const canToggleRecentRun = !running && trace.length > 0 && !!lastRun;
  // 一轮 run 可以有几百个事件、上兆文本，点开历史会话就整条挂上去会明显卡一帧。
  // 所以历史会话默认只渲染「最近执行」摘要卡，完整步骤流等用户点开再挂。
  const recentRunExpanded = running || expandedRunId === currentRunId;
  const showCurrentTrace = running || !canToggleRecentRun || recentRunExpanded;
  const LastRunFrame = canToggleRecentRun ? 'button' : 'div';
  const lastRunClassName = `agent-last-run${lastRun?.status === 'error' ? ' error' : ''}${canToggleRecentRun ? ' agent-last-run-toggle' : ''}`;
  const historyRuns = useMemo(
    // 会话里最多就存这么多条，这里不再另设更小的显示上限——弹框够高，列表自己滚。
    () => previousRuns.filter((run, index) => runKey(run, index) !== currentRunId).slice(0, MAX_AGENT_RUN_HISTORY),
    [currentRunId, previousRuns],
  );

  useEffect(() => {
    setSelectedModelId('all');
  }, [currentRunId]);

  // 正在跑的这一轮登记为“已展开”，这样 run 结束、running 落回 false 之后，
  // 刚看完的步骤流不会在收尾那一刻突然折叠起来。
  useEffect(() => {
    if (running && currentRunId) setExpandedRunId(currentRunId);
  }, [running, currentRunId]);

  useEffect(() => {
    if (selectedModelId !== 'all' && !modelIds.includes(selectedModelId)) setSelectedModelId('all');
  }, [modelIds, selectedModelId]);

  const toggleHistoryRun = useCallback(async (run, index) => {
    const key = runKey(run, index);
    const nextExpanded = expandedHistoryRun === key ? null : key;
    setExpandedHistoryRun(nextExpanded);
    if (!nextExpanded || historyTraceCache[key] || run.trace?.length > 0 || !run.runId) return;

    setHistoryTraceLoading(key);
    try {
      const events = await fetchAgentTrace(run.runId, { projectId });
      const deduped = dedupeTraceEvents(events);
      setHistoryTraceCache(prev => ({ ...prev, [key]: deduped }));
    } catch {
      setHistoryTraceCache(prev => ({ ...prev, [key]: [] }));
    } finally {
      setHistoryTraceLoading(prev => (prev === key ? null : prev));
    }
  }, [expandedHistoryRun, historyTraceCache, projectId]);

  // Screenshot lightbox stays above dialogs and handles its own Escape key.
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = e => {
      if (e.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  useEffect(() => {
    if (!traceStickyRef.current) return;
    // 流式追加期间用瞬时滚动，避免平滑动画相互打断造成抖动。
    traceBottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [trace]);

  // 用户在 trace 容器内手动滚动时维护 sticky 标志：距离底部 80px 内视为"在底部"。
  // 容器是条件渲染的，trace 从空变非空时才挂上 scroll 监听。
  const traceHasContent = trace.length > 0;
  useEffect(() => {
    if (!traceHasContent) return;
    const scroller = traceBottomRef.current?.parentElement;
    if (!scroller) return;
    const onScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      traceStickyRef.current = distance <= 80;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [traceHasContent]);

  // 拖动/缩放期间在 window 上跟踪指针，松手落盘；并锁定全局光标与选区。
  useEffect(() => {
    if (!gesture) return;
    const margin = 8;
    const onMove = e => {
      const o = gestureOrigin.current;
      if (!o) return;
      const dx = e.clientX - o.px;
      const dy = e.clientY - o.py;
      let next;
      if (gesture === 'drag') {
        if (!movedRef.current && Math.hypot(dx, dy) > 3) movedRef.current = true;
        const maxLeft = Math.max(margin, window.innerWidth - o.w - margin);
        const maxTop = Math.max(margin, window.innerHeight - o.h - margin);
        next = {
          left: Math.min(Math.max(margin, o.left + dx), maxLeft),
          top: Math.min(Math.max(margin, o.top + dy), maxTop),
          width: o.hasWidth ? o.w : undefined,
          height: o.hasHeight ? o.h : undefined,
        };
      } else {
        // 左下角手柄：右边缘与顶边钉住，向左/向下拉伸。
        movedRef.current = true; // 缩放结束后的合成 click 不应触发折叠/展开
        const minW = 240, minH = 48;
        const rightEdge = o.left + o.w;
        const width = Math.max(minW, Math.min(o.w - dx, rightEdge - margin));
        const height = Math.max(minH, Math.min(o.h + dy, window.innerHeight - o.top - margin));
        next = { left: rightEdge - width, top: o.top, width, height };
      }
      liveBoxRef.current = next;
      setLiveBox(next);
    };
    const stop = () => {
      if (liveBoxRef.current) setStoredBox(liveBoxRef.current);
      liveBoxRef.current = null;
      setLiveBox(null);
      setGesture(null);
    };
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = gesture === 'resize' ? 'nesw-resize' : 'grabbing';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [gesture, setStoredBox]);

  // 挂载时与窗口缩放后，把悬浮框夹回可视区域，避免上次的位置/尺寸在更小的窗口里越界。
  const clampStoredBox = useCallback(() => {
    const prev = storedBoxRef.current;
    if (!prev || prev.left == null) return;
    const margin = 8;
    const rect = headRef.current?.getBoundingClientRect();
    const width = prev.width != null ? Math.min(prev.width, window.innerWidth - margin * 2) : undefined;
    const height = prev.height != null ? Math.min(prev.height, window.innerHeight - margin * 2) : undefined;
    const w = width ?? rect?.width ?? 0;
    const h = height ?? rect?.height ?? 0;
    const left = Math.min(Math.max(margin, prev.left), Math.max(margin, window.innerWidth - w - margin));
    const top = Math.min(Math.max(margin, prev.top ?? margin), Math.max(margin, window.innerHeight - h - margin));
    if (left === prev.left && top === prev.top && width === prev.width && height === prev.height) return;
    setStoredBox({ ...prev, left, top, width, height });
  }, [setStoredBox]);

  useEffect(() => {
    clampStoredBox();
    window.addEventListener('resize', clampStoredBox);
    return () => window.removeEventListener('resize', clampStoredBox);
  }, [clampStoredBox]);

  return (
    <>
    <section className={`agent-panel ${!isMobile && collapsed ? 'collapsed' : ''}`}>
      {headVisible && (
      <div
        ref={headRef}
        className={`agent-panel-head${gesture ? ' dragging' : ''}`}
        style={box && !isMobile ? {
          ...(box.left != null ? { left: box.left, top: box.top, right: 'auto', margin: 0 } : null),
          ...(box.width != null ? { width: box.width } : null),
          ...(box.height != null ? { height: box.height } : null),
        } : undefined}
        onPointerDown={beginHeadDrag}
        onClick={collapsed && trace.length > 0 ? handleHeadClick : undefined}
      >
        <div className="agent-head-row-primary">
          <div className="agent-panel-status" role="status" aria-live="polite">
            <span className={`agent-status-dot ${headerStatus}`} aria-hidden="true" />
            <h3 className="agent-panel-title">{headerTitle}</h3>
          </div>
          {running && onStop && (
            <button className="agent-stop-btn" onClick={e => { e.stopPropagation(); onStop(); }} disabled={agentStopping} title={t('agentPanel.stopTitle')}>
              <Square size={10} /> {agentStopping ? t('agentPanel.stopping') : pendingApproval ? t('agentPanel.stopAndReject') : t('agentPanel.stop')}
            </button>
          )}
          <div className="agent-head-actions">
            {hasModelCards && !collapsed && showCurrentTrace && (
              <button
                className="agent-collapse-btn agent-cards-toggle"
                onClick={e => { e.stopPropagation(); setCardsExpanded(allCardsExpanded ? false : true); }}
                title={allCardsExpanded ? t('agentPanel.collapseAllTitle') : t('agentPanel.expandAllTitle')}
                aria-label={allCardsExpanded ? t('agentPanel.collapseAllTitle') : t('agentPanel.expandAllTitle')}
                aria-pressed={allCardsExpanded}
              >
                {allCardsExpanded ? <ChevronsUp size={14} /> : <ChevronsDown size={14} />}
              </button>
            )}
            {trace.length > 0 && (
              <button className="agent-collapse-btn agent-tablet-only" onClick={e => { e.stopPropagation(); onToggleCollapse(); }} title={collapsed ? t('agentPanel.expand') : t('agentPanel.collapseShort')}>
                {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              </button>
            )}
          </div>
        </div>
        <div className="agent-head-row-metrics">
          {headerStepCount > 0 && (
            <span className="agent-metric">
              {running ? `Step ${headerStepCount}` : t('agentPanel.stepCount', { n: headerStepCount })}
            </span>
          )}
          {(running || doneMeta.elapsed_ms) && (
            <ElapsedTimer running={running} startedAt={startedAt} paused={hasPendingQuestion} finalMs={doneMeta.elapsed_ms} />
          )}
          {metrics.totalTokens > 0 && (
            <span className="agent-metric agent-metric-tokens">{formatTokenCount(metrics.totalTokens)} tok</span>
          )}
          {browserHealth && (
            <span
              className={`agent-browser-compact ${browserHealth.status}`}
              title={[
                t('agentPanel.browserHealth'),
                t(`agentPanel.browserStatus.${browserHealth.status}`),
                browserHealth.url,
                browserHealth.sessionId ? `Session #${browserHealth.sessionId}` : null,
                browserHealth.recoveries > 0 ? t('agentPanel.browserRecoveries', { n: browserHealth.recoveries }) : null,
              ].filter(Boolean).join(' · ')}
            >
              <Monitor size={11} aria-hidden="true" />
              <span className="agent-browser-compact-dot" aria-hidden="true" />
              <strong>{t('agentPanel.browserHealth')}</strong>
              <span>{t(`agentPanel.browserStatus.${browserHealth.status}`)}</span>
            </span>
          )}
        </div>
        {browserHealth?.screenshotUrl && !collapsed && (
          <button
            type="button"
            className="agent-browser-preview"
            onClick={event => { event.stopPropagation(); setLightboxSrc(browserHealth.screenshotUrl); }}
            title={browserHealth.url || browserHealth.title || t('agentPanel.browserHealth')}
            aria-label={`${t('agentPanel.browserHealth')}: ${browserHealth.title || browserHealth.url || t(`agentPanel.browserStatus.${browserHealth.status}`)}`}
          >
            <img src={browserHealth.screenshotUrl} alt="" />
            <span className="agent-browser-preview-caption">
              <Monitor size={11} aria-hidden="true" />
              <span>{browserHealth.title || browserHealth.url}</span>
            </span>
          </button>
        )}
        {!isMobile && (
          <span
            className="agent-panel-head-resize"
            onPointerDown={beginHeadResize}
            aria-hidden="true"
          />
        )}
      </div>
      )}

      <div className="agent-panel-body">
        <>
          <p className="agent-panel-note">
            {t('agentPanel.note')}
          </p>

          {!running && lastRun && (
            <LastRunFrame
              className={lastRunClassName}
              {...(canToggleRecentRun ? {
                type: 'button',
                onClick: () => setExpandedRunId(prev => (prev === currentRunId ? null : currentRunId)),
                'aria-expanded': recentRunExpanded,
              } : {})}
            >
              <div className="agent-last-run-head">
                <div>
                  <span className="agent-last-run-kicker">{t('agentPanel.recentRun')}</span>
                  <strong title={lastRun.task}>{lastRun.task || t('agent.taskFallback')}</strong>
                </div>
                <span className="agent-last-run-status-wrap">
                  <span className="agent-last-run-status" title={lastRun.endedAt ? formatFullTime(lastRun.endedAt) : ''}>
                    {lastRun.endedAt ? formatRelativeTime(lastRun.endedAt) : statusLabel(lastRun.status, t)}
                  </span>
                  {canToggleRecentRun && (
                    <span className="agent-last-run-toggle-hint">
                      {recentRunExpanded ? t('agentPanel.collapseTrace') : t('agentPanel.expandTrace')}
                      {recentRunExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </span>
                  )}
                </span>
              </div>
              <div className="agent-last-run-grid">
                <span><Clock3 size={11} />{formatDurationMs(lastRun.elapsedMs)}</span>
                <span><ListChecks size={11} />{t('agentPanel.stepCount', { n: lastRun.stepCount })}</span>
                <span><Coins size={11} />{formatTokenCount(lastRun.totalTokens)} tok</span>
                <span><Bot size={11} />{lastRunModels.slice(0, 2).join(' + ') || t('session.unknownModel')}</span>
                <span><Trophy size={11} />{strategyLabel(lastRun.strategy, t)}</span>
              </div>
            </LastRunFrame>
          )}

          {trace.length > 0 && showCurrentTrace && modelIds.length > 1 && (
            <div className="agent-model-filter" aria-label={t('agentPanel.modelFilter')}>
              <span>{t('agentPanel.modelFilter')}</span>
              <div className="agent-model-filter-chips">
                <button className={selectedModelId === 'all' ? 'active' : ''} onClick={() => setSelectedModelId('all')}>{t('agentPanel.allModels')}</button>
                {modelIds.map(modelId => (
                  <button key={modelId} className={selectedModelId === modelId ? 'active' : ''} onClick={() => setSelectedModelId(modelId)}>{getModelLabel(modelId, modelList)}</button>
                ))}
              </div>
            </div>
          )}

          {trace.length === 0 && running ? (
            <div className="agent-skeleton">
              <div className="agent-skeleton-line agent-skeleton-line--w60" />
              <div className="agent-skeleton-line agent-skeleton-line--w90" />
              <div className="agent-skeleton-line agent-skeleton-line--w70" />
              <Loader2 size={14} className="agent-skeleton-spinner" />
            </div>
          ) : trace.length === 0 ? (
            <div className="agent-empty">
              <Monitor size={28} className="agent-empty-icon" />
              <span>{t('agentPanel.emptyHint')}</span>
            </div>
          ) : showCurrentTrace ? (
            <AgentTraceTimeline
              trace={trace}
              running={running}
              modelList={modelList}
              cardsExpanded={cardsExpanded}
              onManualToggle={() => setCardsExpanded(null)}
              onRollback={stableRollback}
              rollbackLoading={rollbackLoading}
              openLightbox={setLightboxSrc}
              t={t}
              bottomRef={traceBottomRef}
              selectedModelId={selectedModelId}
            />
          ) : null}
            </>
      </div>
    </section>
    {headerActionsHost && createPortal((
      <>
        {trace.length > 0 && (
          <button
            className="header-icon-btn header-agent-action-btn"
            onClick={() => setTraceDebugOpen(true)}
            title={t('agentPanel.traceDebug')}
          >
            <Activity size={14} />
          </button>
        )}
        {trace.length > 0 && (
          <button
            className="header-icon-btn header-agent-action-btn"
            onClick={() => setHeadVisible(visible => !visible)}
            title={headVisible ? t('agentPanel.hidePanel') : t('agentPanel.showPanel')}
            aria-label={headVisible ? t('agentPanel.hidePanel') : t('agentPanel.showPanel')}
            aria-pressed={!headVisible}
          >
            {headVisible ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        {historyRuns.length > 0 && (
          <button
            className="header-icon-btn header-agent-action-btn"
            onClick={() => setHistoryDialogOpen(true)}
            title={t('agentPanel.previousRuns')}
          >
            <History size={14} />
            <span className="header-agent-action-count">{historyRuns.length}</span>
          </button>
        )}
      </>
    ), headerActionsHost)}
    {traceDebugOpen && (
      <DialogShell
        title={t('agentPanel.traceDebug')}
        subtitle={t('agentPanel.traceDebugMeta', { llm: metrics.llmCalls, tools: metrics.completedToolCalls })}
        onClose={() => setTraceDebugOpen(false)}
        dialogClassName="settings-dialog trace-debug-dialog"
      >
        <div className="trace-debug-dialog-body">
          {modelIds.length > 1 && (
            <div className="agent-model-filter trace-debug-model-filter" aria-label={t('agentPanel.modelFilter')}>
              <span>{t('agentPanel.modelFilter')}</span>
              <div className="agent-model-filter-chips">
                <button className={traceDebugModelId === 'all' ? 'active' : ''} onClick={() => setTraceDebugModelId('all')}>{t('agentPanel.allModels')}</button>
                {modelIds.map(modelId => (
                  <button key={modelId} className={traceDebugModelId === modelId ? 'active' : ''} onClick={() => setTraceDebugModelId(modelId)}>{getModelLabel(modelId, modelList)}</button>
                ))}
              </div>
            </div>
          )}
          <TraceDebugPanel metrics={metrics} trace={trace} selectedModelId={traceDebugModelId} modelList={modelList} t={t} />
        </div>
      </DialogShell>
    )}
    {historyDialogOpen && (
      <DialogShell
        title={t('agentPanel.previousRuns')}
        subtitle={t('agentPanel.previousRunsCap', { n: historyRuns.length, max: MAX_AGENT_RUN_HISTORY })}
        onClose={() => setHistoryDialogOpen(false)}
        escapeDisabled={!!lightboxSrc}
        maskClassName="agent-history-dialog-mask"
        dialogClassName="agent-history-dialog"
      >
          <div className="agent-run-history agent-run-history--dialog">
            {historyRuns.map((run, index) => {
              const key = runKey(run, index);
              const meta = run.meta || {};
              const title = meta.task || t('agent.taskFallback');
              const expanded = expandedHistoryRun === key;
              const cachedTrace = historyTraceCache[key];
              const historyTrace = Array.isArray(run.trace) && run.trace.length > 0 ? run.trace : (cachedTrace || []);
              const loading = historyTraceLoading === key;
              const models = (meta.models || []).map(model => modelList.find(item => item.id === model)?.label || model);
              return (
                <div className="agent-history-run" key={key}>
                  <button className="agent-history-run-toggle" onClick={() => toggleHistoryRun(run, index)}>
                    <span className="agent-history-run-main">
                      <strong title={title}>{title}</strong>
                      <span>{formatDurationMs(meta.elapsedMs || 0)} · {formatTokenCount(meta.totalTokens || 0)} tok · {t('agentPanel.stepCount', { n: meta.stepCount || 0 })}</span>
                    </span>
                    <span className="agent-history-run-side">
                      <span className={`agent-run-status-tag ${statusTone(meta.status)}`}>{statusLabel(meta.status, t)}</span>
                      <span className="agent-history-run-models">{models.slice(0, 2).join(' + ') || t('session.unknownModel')}</span>
                      {meta.endedAt && (
                        <span title={formatFullTime(meta.endedAt)}>{formatRelativeTime(meta.endedAt)}</span>
                      )}
                      {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </span>
                  </button>
                  {expanded && (
                    <div className="agent-history-trace">
                      {loading ? (
                        <div className="agent-history-empty">{t('agentPanel.historyLoading')}</div>
                      ) : historyTrace.length === 0 ? (
                        <div className="agent-history-empty">{t('agentPanel.historyTraceUnavailable')}</div>
                      ) : (
                        <AgentTraceTimeline trace={historyTrace} running={false} modelList={modelList} cardsExpanded={false} onManualToggle={disabledRollback} onRollback={disabledRollback} rollbackLoading openLightbox={setLightboxSrc} t={t} history />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
      </DialogShell>
    )}
    {lightboxSrc && (
      <div className="screenshot-lightbox" onClick={() => setLightboxSrc(null)}>
        <img className="screenshot-lightbox-img" src={lightboxSrc} alt="screenshot" />
      </div>
    )}
    </>
  );
}
