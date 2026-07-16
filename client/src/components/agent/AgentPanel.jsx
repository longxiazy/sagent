import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Square, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp,
  Monitor, Loader2, Bot, Clock3, Coins, ListChecks, Trophy, History, Activity,
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
import { useT } from '../../i18n/I18nProvider.jsx';
import { formatFullTime, formatRelativeTime } from '../../utils/format.js';
import { fetchAgentTrace } from '../../api/streams.js';
import { appendUniqueTraceEvent } from '../../utils/agent-trace.js';
import { DialogShell } from '../dialogs/DialogShell.jsx';
import { attemptStepKey, buildAttemptTraceIndex } from '../../utils/agent-attempts.js';

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
    singleModelSteps,
    multiModelSteps,
    terminalAttempts,
    latestAttempt,
  } = attemptIndex;
  const previousRequests = new Map();

  return (
    <div className={`agent-trace${history ? ' agent-trace--history' : ''}`}>
      {entries.map(({ event, index, attempt }) => {
        const stepKey = event.step == null ? null : attemptStepKey(attempt, event.step);
        const stepEvents = stepKey ? (eventsByStep.get(stepKey) || []) : [];
        const stepModelEvent = stepEvents.find(e => e.type === 'model_plan' && (e.stage === 'success' || e.stage === 'winner'));
        const previousRequest = event.type === 'model_plan'
          ? (event.model ? previousRequests.get(event.model) : null)
          : (stepModelEvent?.model ? previousRequests.get(stepModelEvent.model) : null);
        if (event.type === 'model_plan' && event.model && Array.isArray(event.requests) && event.requests.length > 0) {
          previousRequests.set(event.model, event.requests[event.requests.length - 1]);
        }
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
                previousRequests={previousRequests}
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
  const [recentRunExpanded, setRecentRunExpanded] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState('all');

  // onRollback 来自上层且每次 render 是新引用；用 ref 包出稳定回调，
  // 这样 memo 化的 TraceItem 不会因为回调引用变化而整片重渲。
  const rollbackRef = useRef(onRollback);
  useEffect(() => { rollbackRef.current = onRollback; }, [onRollback]);
  const stableRollback = useCallback(step => rollbackRef.current?.(step), []);
  const disabledRollback = useCallback(() => {}, []);

  // 以下派生值原先每次 render（含每秒计时 tick）都对整条 trace 做 some/reduce/find，
  // 现在统一 memo 化，只在 trace/running 变化时重算。
  const metrics = useMemo(() => computeTraceMetrics(trace), [trace]);
  const browserHealth = useMemo(() => {
    const events = trace.filter(event => event.type === 'browser_session' || (event.type === 'status' && event.status === 'browser_ready'));
    const latest = events.at(-1);
    if (!latest) return null;
    const recoveries = events.filter(event => event.type === 'browser_session' && event.status === 'recovering').length;
    return { ...latest, status: latest.status === 'browser_ready' ? 'ready' : latest.status, recoveries };
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
  const lastRunModels = useMemo(
    () => (lastRun?.models || []).map(model => modelList.find(item => item.id === model)?.label || model),
    [lastRun, modelList],
  );
  const currentRunId = lastRun?.runId || traceRunId(trace);
  const canToggleRecentRun = !running && trace.length > 0 && !!lastRun;
  const showCurrentTrace = running || !canToggleRecentRun || recentRunExpanded;
  const LastRunFrame = canToggleRecentRun ? 'button' : 'div';
  const lastRunClassName = `agent-last-run${lastRun?.status === 'error' ? ' error' : ''}${canToggleRecentRun ? ' agent-last-run-toggle' : ''}`;
  const historyRuns = useMemo(
    () => previousRuns.filter((run, index) => runKey(run, index) !== currentRunId).slice(0, 8),
    [currentRunId, previousRuns],
  );

  useEffect(() => {
    setRecentRunExpanded(true);
    setSelectedModelId('all');
  }, [currentRunId]);

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
      const deduped = events.reduce((acc, event) => appendUniqueTraceEvent(acc, event), []);
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

  return (
    <>
    <section className={`agent-panel ${!isMobile && collapsed ? 'collapsed' : ''}`}>
      <div className="agent-panel-head" onClick={collapsed && trace.length > 0 ? onToggleCollapse : undefined}>
        <div className="agent-head-row-primary">
          <div>
            <p className="agent-panel-eyebrow">Desktop Agent</p>
            <h3 className="agent-panel-title">{running ? t('agentPanel.running') : t('agentPanel.lastRun')}</h3>
          </div>
          <span className={`agent-status-chip ${running ? 'running' : 'idle'}`}>{running ? 'Running' : 'Idle'}</span>
          {running && onStop && (
            <button className="agent-stop-btn" onClick={e => { e.stopPropagation(); onStop(); }} disabled={agentStopping} title={t('agentPanel.stopTitle')}>
              <Square size={10} /> {agentStopping ? t('agentPanel.stopping') : pendingApproval ? t('agentPanel.stopAndReject') : t('agentPanel.stop')}
            </button>
          )}
          <div className="agent-head-actions">
            {hasModelCards && !collapsed && showCurrentTrace && (
              <>
                <button className="agent-collapse-btn agent-expand-all" onClick={e => { e.stopPropagation(); setCardsExpanded(true); }} title={t('agentPanel.expandAllTitle')}>
                  <ChevronsDown size={12} /> {t('agentPanel.expand')}
                </button>
                <button className="agent-collapse-btn agent-collapse-all" onClick={e => { e.stopPropagation(); setCardsExpanded(false); }} title={t('agentPanel.collapseAllTitle')}>
                  <ChevronsUp size={12} /> {t('agentPanel.collapse')}
                </button>
              </>
            )}
            {trace.length > 0 && (
              <button className="agent-collapse-btn agent-tablet-only" onClick={e => { e.stopPropagation(); onToggleCollapse(); }} title={collapsed ? t('agentPanel.expand') : t('agentPanel.collapseShort')}>
                {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              </button>
            )}
          </div>
        </div>
        <div className="agent-head-row-metrics">
          {metrics.lastStep > 0 && <span className="agent-metric">Step {metrics.lastStep}</span>}
          <ElapsedTimer running={running} startedAt={startedAt} paused={hasPendingQuestion} finalMs={doneMeta.elapsed_ms} />
          {metrics.totalTokens > 0 && (
            <span className="agent-metric agent-metric-tokens">{metrics.totalTokens} tokens</span>
          )}
          {!running && doneMeta.step_count && (
            <span className="agent-metric">{t('agentPanel.stepCount', { n: doneMeta.step_count })}</span>
          )}
          {!running && doneEvent && doneStatus !== 'done' && (
            <span className="agent-metric">{doneStatusLabel}</span>
          )}
        </div>
      </div>

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
                onClick: () => setRecentRunExpanded(v => !v),
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
                  {canToggleRecentRun && (recentRunExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
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

          {trace.length > 0 && showCurrentTrace && browserHealth && (
            <div className={`agent-browser-health ${browserHealth.status}`}>
              <span className="agent-browser-health-dot" />
              <strong>{t('agentPanel.browserHealth')}</strong>
              <span>{t(`agentPanel.browserStatus.${browserHealth.status}`)}</span>
              {browserHealth.url && <span className="agent-browser-health-url" title={browserHealth.url}>{browserHealth.url}</span>}
              {browserHealth.sessionId && <span>Session #{browserHealth.sessionId}</span>}
              {browserHealth.recoveries > 0 && <span>{t('agentPanel.browserRecoveries', { n: browserHealth.recoveries })}</span>}
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
        subtitle={historyRuns.length}
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
                      <span>{models.slice(0, 2).join(' + ') || t('session.unknownModel')}</span>
                      <span title={meta.endedAt ? formatFullTime(meta.endedAt) : ''}>{meta.endedAt ? formatRelativeTime(meta.endedAt) : statusLabel(meta.status, t)}</span>
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
