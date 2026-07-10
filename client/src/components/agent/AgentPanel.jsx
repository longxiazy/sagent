import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Square, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp,
  Monitor, Loader2, Bot, Clock3, Coins, ListChecks, Trophy, History,
} from 'lucide-react';
import { PHONE_BREAKPOINT } from '../../utils/constants.js';
import { ModelPlanGroup } from './ModelPlanGroup.jsx';
import { ElapsedTimer } from './ElapsedTimer.jsx';
import { TraceItem } from './TraceItem.jsx';
import { StepCard } from './StepCard.jsx';
import { computeTraceMetrics, formatDurationMs, formatTokenCount } from './trace-metrics.js';
import { TraceDebugPanel } from './TraceDebugPanel.jsx';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { useT } from '../../i18n/I18nProvider.jsx';
import { formatFullTime, formatRelativeTime } from '../../utils/format.js';
import { fetchAgentTrace } from '../../api/streams.js';
import { appendUniqueTraceEvent } from '../../utils/agent-trace.js';
import { DialogShell } from '../dialogs/DialogShell.jsx';

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
  if (event.type === 'session_checkpoint') return true;
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
}) {
  const metrics = useMemo(() => computeTraceMetrics(trace), [trace]);
  const agentFinished = useMemo(
    () => !running && trace.some(e => e.type === 'done' || e.type === 'error'),
    [running, trace],
  );
  const eventsByStep = useMemo(() => {
    const map = new Map();
    for (const e of trace) {
      if (e.step == null) continue;
      let arr = map.get(e.step);
      if (!arr) { arr = []; map.set(e.step, arr); }
      arr.push(e);
    }
    return map;
  }, [trace]);
  const multiModelSteps = useMemo(() => {
    const set = new Set();
    for (const e of trace) {
      if (e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 1) set.add(e.step);
    }
    return set;
  }, [trace]);
  const singleModelSteps = useMemo(() => {
    const set = new Set();
    for (const e of trace) {
      if (e.type === 'model_plan' && e.stage === 'start' && e.models?.length === 1) set.add(e.step);
    }
    return set;
  }, [trace]);

  return (
    <div className={`agent-trace${history ? ' agent-trace--history' : ''}`}>
      {trace.map((event, index) => {
        // 系统级提示不进时间线：启动提示 / 浏览器就绪 / 后台健康快照都是噪音，
        // 不是 agent 的实质步骤；断点恢复 status='resuming' 有信息量，保留。
        if (shouldHideTimelineEvent(event)) return null;
        // ── model_plan ──
        if (event.type === 'model_plan') {
          // start：多模型渲染对比卡组；单模型并入 StepCard，不单独渲染
          if (event.stage === 'start') {
            return event.models?.length > 1 ? (
              <ModelPlanGroup
                key={`model-plan-step-${event.step ?? index}-${index}`}
                events={eventsByStep.get(event.step) || []}
                step={event.step}
                models={event.models}
                modelList={modelList}
                agentFinished={agentFinished}
                cardsExpanded={cardsExpanded}
                onManualToggle={onManualToggle}
                onRollback={onRollback}
                rollbackLoading={rollbackLoading}
                openLightbox={openLightbox}
              />
            ) : null;
          }
          // consensus 落到底部 TraceItem 单独展示；其它阶段在卡组内显示，跳过
          if (event.stage !== 'consensus') return null;
        }

        // ── step ──
        if (event.type === 'step') {
          // 单模型：observe/action/result 合并成一张 StepCard，只在 observe 处渲染一次
          if (singleModelSteps.has(event.step)) {
            return event.stage === 'observe' ? (
              <StepCard
                key={`step-card-${event.step ?? index}`}
                events={eventsByStep.get(event.step) || []}
                step={event.step}
                active={running && event.step === metrics.lastStep}
                modelList={modelList}
                onRollback={onRollback}
                rollbackLoading={rollbackLoading}
                openLightbox={openLightbox}
                forceExpanded={cardsExpanded}
                onManualToggle={onManualToggle}
                t={t}
              />
            ) : null;
          }
          // 多模型：observe/action/result 都并入决策卡组（与单模型 StepCard 一致，一步一节点），这里跳过
          if (multiModelSteps.has(event.step) && (event.stage === 'observe' || event.stage === 'action' || event.stage === 'result')) {
            return null;
          }
        }

        if (event.type === 'terminal_output' && (singleModelSteps.has(event.step) || multiModelSteps.has(event.step))) {
          return null;
        }

        // consensus + 其余事件（status/notification/approval/done/error/...）
        return (
          <TraceItem
            key={`${event.type}-${event.step ?? index}-${event.stage ?? index}-${index}`}
            event={event}
            modelList={modelList}
            onRollback={onRollback}
            rollbackLoading={rollbackLoading}
            openLightbox={openLightbox}
            t={t}
          />
        );
      })}
      {bottomRef && <div ref={bottomRef} />}
    </div>
  );
}

export function AgentPanel({ running, trace, startedAt, lastRun, previousRuns = [], projectId = null, modelList, collapsed, onToggleCollapse, onStop, agentStopping, pendingApproval, onRollback, rollbackLoading }) {
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
  const [recentRunExpanded, setRecentRunExpanded] = useState(true);

  // onRollback 来自上层且每次 render 是新引用；用 ref 包出稳定回调，
  // 这样 memo 化的 TraceItem 不会因为回调引用变化而整片重渲。
  const rollbackRef = useRef(onRollback);
  useEffect(() => { rollbackRef.current = onRollback; }, [onRollback]);
  const stableRollback = useCallback(step => rollbackRef.current?.(step), []);
  const disabledRollback = useCallback(() => {}, []);

  // 以下派生值原先每次 render（含每秒计时 tick）都对整条 trace 做 some/reduce/find，
  // 现在统一 memo 化，只在 trace/running 变化时重算。
  const metrics = useMemo(() => computeTraceMetrics(trace), [trace]);
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
  }, [currentRunId]);

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
            {historyRuns.length > 0 && (
              <button
                className="agent-collapse-btn agent-history-btn"
                onClick={e => { e.stopPropagation(); setHistoryDialogOpen(true); }}
                title={t('agentPanel.previousRuns')}
              >
                <History size={12} />
                <span>{t('agentPanel.previousRuns')}</span>
                <span className="agent-history-btn-count">{historyRuns.length}</span>
              </button>
            )}
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

          {trace.length > 0 && showCurrentTrace && <TraceDebugPanel metrics={metrics} t={t} />}

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
            />
          ) : null}
            </>
      </div>
    </section>
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
