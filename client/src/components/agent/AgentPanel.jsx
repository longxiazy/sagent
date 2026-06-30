import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Square, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp,
  Monitor, Loader2,
} from 'lucide-react';
import { PHONE_BREAKPOINT } from '../../utils/constants.js';
import { ModelPlanGroup } from './ModelPlanGroup.jsx';
import { ElapsedTimer } from './ElapsedTimer.jsx';
import { TraceItem } from './TraceItem.jsx';
import { StepCard } from './StepCard.jsx';
import { computeTraceMetrics } from './trace-metrics.js';
import { TraceDebugPanel } from './TraceDebugPanel.jsx';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { useT } from '../../i18n/I18nProvider.jsx';

// AgentPanel 既是执行面板，也是运行时仪表盘：
// - 负责展示 trace
// - 负责显示暂停/审批/用时/token 等运行态指标
// - 在移动端和桌面端之间复用同一套事件展示逻辑
export function AgentPanel({ running, trace, startedAt, modelList, collapsed, onToggleCollapse, onStop, agentStopping, pendingApproval, onRollback, rollbackLoading }) {
  const t = useT();
  const traceBottomRef = useRef(null);
  const traceStickyRef = useRef(true);
  const isMobile = useIsMobile(PHONE_BREAKPOINT);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [cardsExpanded, setCardsExpanded] = useState(null); // null=auto, true=all open, false=all closed

  // onRollback 来自上层且每次 render 是新引用；用 ref 包出稳定回调，
  // 这样 memo 化的 TraceItem 不会因为回调引用变化而整片重渲。
  const rollbackRef = useRef(onRollback);
  useEffect(() => { rollbackRef.current = onRollback; }, [onRollback]);
  const stableRollback = useCallback(step => rollbackRef.current?.(step), []);

  // 以下派生值原先每次 render（含每秒计时 tick）都对整条 trace 做 some/reduce/find，
  // 现在统一 memo 化，只在 trace/running 变化时重算。
  const metrics = useMemo(() => computeTraceMetrics(trace), [trace]);
  const hasModelCards = useMemo(
    () => trace.some(e => e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 0),
    [trace],
  );
  const doneEvent = useMemo(() => trace.find(e => e.type === 'done'), [trace]);
  const agentFinished = useMemo(
    () => !running && trace.some(e => e.type === 'done' || e.type === 'error'),
    [running, trace],
  );
  // Detect if waiting for user question
  const hasPendingQuestion = useMemo(
    () => running && trace.some(e => e.type === 'question_required') && !trace.some(e => e.type === 'user_response'),
    [running, trace],
  );
  // 把事件按 step 预分组一次，供 ModelPlanGroup 直接取用，避免每个 group 再各自
  // 遍历整条 trace（否则 S 步 × N 事件 = O(N²)）。
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
  // 多模型规划的步：其 action/result 展示在模型卡片内部，trace 里需跳过单独项。
  const multiModelSteps = useMemo(() => {
    const set = new Set();
    for (const e of trace) {
      if (e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 1) set.add(e.step);
    }
    return set;
  }, [trace]);
  // 单模型的步：observe/action/result 合并成一张 StepCard，model_plan 折叠废卡不再单独渲染。
  const singleModelSteps = useMemo(() => {
    const set = new Set();
    for (const e of trace) {
      if (e.type === 'model_plan' && e.stage === 'start' && e.models?.length === 1) set.add(e.step);
    }
    return set;
  }, [trace]);

  const doneMeta = doneEvent?.meta || {};
  const doneStatus = doneEvent?.quality?.status || doneMeta.status || 'done';
  const doneStatusLabel = doneStatus === 'done_unverified'
    ? t('agentPanel.statusUnverified')
    : doneStatus === 'done_degraded'
      ? t('agentPanel.statusDegraded')
      : t('agentPanel.statusDone');

  // ESC closes lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = e => { if (e.key === 'Escape') setLightboxSrc(null); };
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
            {hasModelCards && !collapsed && (
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

          {trace.length > 0 && <TraceDebugPanel metrics={metrics} t={t} />}

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
              ) : (
                <div className="agent-trace">
          {trace.map((event, index) => {
            // 系统级提示不进时间线：启动提示 / 浏览器就绪 / 后台健康快照都是噪音，
            // 不是 agent 的实质步骤；断点恢复 status='resuming' 有信息量，保留。
            if (event.type === 'session_checkpoint') return null;
            if (event.type === 'status' && (event.status === 'starting' || event.status === 'browser_ready')) return null;
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
                    onManualToggle={() => setCardsExpanded(null)}
                    onRollback={stableRollback}
                    rollbackLoading={rollbackLoading}
                    openLightbox={setLightboxSrc}
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
                    onRollback={stableRollback}
                    rollbackLoading={rollbackLoading}
                    openLightbox={setLightboxSrc}
                    forceExpanded={cardsExpanded}
                    onManualToggle={() => setCardsExpanded(null)}
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
                key={`${event.type}-${event.step ?? index}-${event.stage ?? index}`}
                event={event}
                modelList={modelList}
                onRollback={stableRollback}
                rollbackLoading={rollbackLoading}
                openLightbox={setLightboxSrc}
                t={t}
              />
            );
          })}
          <div ref={traceBottomRef} />
        </div>
      )}
            </>
      </div>
    </section>
    {lightboxSrc && (
      <div className="screenshot-lightbox" onClick={() => setLightboxSrc(null)}>
        <img className="screenshot-lightbox-img" src={lightboxSrc} alt="screenshot" />
      </div>
    )}
    </>
  );
}
