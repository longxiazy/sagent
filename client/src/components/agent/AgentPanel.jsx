import { useEffect, useRef, useState } from 'react';
import {
  Timer, Square, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp,
  RotateCcw, Monitor, Loader2,
} from 'lucide-react';
import { PHONE_BREAKPOINT } from '../../utils/constants.js';
import { ModelPlanGroup } from './ModelPlanGroup.jsx';
import { getModelLabel } from './plan-stage.js';
import { useT } from '../../i18n/I18nProvider.jsx';

// AgentPanel 既是执行面板，也是运行时仪表盘：
// - 负责展示 trace
// - 负责显示暂停/审批/用时/token 等运行态指标
// - 在移动端和桌面端之间复用同一套事件展示逻辑
export function AgentPanel({ mode, running, trace, startedAt, modelList, collapsed, onToggleCollapse, onStop, agentStopping, pendingApproval, onRollback, rollbackLoading }) {
  const t = useT();
  const traceBottomRef = useRef(null);
  const traceStickyRef = useRef(true);
  const startTimeRef = useRef(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < PHONE_BREAKPOINT;
  const pauseRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [cardsExpanded, setCardsExpanded] = useState(null); // null=auto, true=all open, false=all closed
  const hasModelCards = trace.some(e => e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 0);

  // ESC closes lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = e => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  const lastStep = trace.reduce((max, e) => (e.step != null ? Math.max(max, e.step) : max), 0);
  const doneEvent = trace.find(e => e.type === 'done');
  const doneMeta = doneEvent?.meta || {};
  const doneStatus = doneEvent?.quality?.status || doneMeta.status || 'done';
  const doneStatusLabel = doneStatus === 'done_unverified'
    ? t('agentPanel.statusUnverified')
    : doneStatus === 'done_degraded'
      ? t('agentPanel.statusDegraded')
      : t('agentPanel.statusDone');

  // Detect if waiting for user question
  const hasPendingQuestion = running && trace.some(e => e.type === 'question_required') &&
    !trace.some(e => e.type === 'user_response');

  const totalTokens = trace.reduce((sum, e) => {
    if (e.usage) {
      return sum + (e.usage.prompt_tokens || 0) + (e.usage.completion_tokens || 0);
    }
    return sum;
  }, 0);

  useEffect(() => {
    if (!running) {
      startTimeRef.current = null;
      pauseRef.current = null;
      return;
    }
    startTimeRef.current = startedAt || Date.now();
    pauseRef.current = null;
    const timer = setInterval(() => {
      if (startTimeRef.current) {
        const paused = pauseRef.current ? Date.now() - pauseRef.current : 0;
        setElapsed(Math.round((Date.now() - startTimeRef.current - paused) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  // Pause/resume elapsed when waiting for question
  useEffect(() => {
    if (hasPendingQuestion && !pauseRef.current) {
      pauseRef.current = Date.now();
    } else if (!hasPendingQuestion && pauseRef.current) {
      startTimeRef.current += Date.now() - pauseRef.current;
      pauseRef.current = null;
    }
  }, [hasPendingQuestion]);

  useEffect(() => {
    if (!traceStickyRef.current) return;
    traceBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  if (mode !== 'agent') {
    return null;
  }

  const formatElapsed = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m${s < 10 ? '0' : ''}${s}s` : `${s}s`;
  };

  const displayElapsed = running
    ? formatElapsed(elapsed)
    : doneMeta.elapsed_ms
      ? formatElapsed(Math.round(doneMeta.elapsed_ms / 1000))
      : elapsed > 0 ? formatElapsed(elapsed) : '-';

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
          {lastStep > 0 && <span className="agent-metric">Step {lastStep}</span>}
          <span className={`agent-metric ${running ? 'agent-metric-timer' : ''}`}>
            {running ? <>{displayElapsed} <Timer size={12} /></> : displayElapsed}
          </span>
          {totalTokens > 0 && (
            <span className="agent-metric agent-metric-tokens">{totalTokens} tokens</span>
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
          {(() => {
            // Track which steps have multi-model planning (action/result shown inside cards)
            const multiModelSteps = new Set();
            for (const e of trace) {
              if (e.type === 'model_plan' && e.stage === 'start' && e.models?.length > 1) {
                multiModelSteps.add(e.step);
              }
            }
            return trace.map((event, index) => {
            // model_plan events: only render 'start' as ModelPlanGroup, 'consensus' as standalone
            // (other stages like thinking/success/failed are collected inside ModelPlanGroup)
            if (event.type === 'model_plan' && event.stage !== 'start' && event.stage !== 'consensus') return null;
            if (event.type === 'model_plan' && event.stage === 'start') {
              return <ModelPlanGroup key={`model-plan-step-${event.step || index}-${index}`} trace={trace} step={event.step} models={event.models} modelList={modelList} running={running} cardsExpanded={cardsExpanded} onManualToggle={() => setCardsExpanded(null)} onRollback={onRollback} rollbackLoading={rollbackLoading} />;
            }
            // For multi-model steps, skip separate action/result items (shown inside model cards)
            if (event.type === 'step' && (event.stage === 'action' || event.stage === 'result') && multiModelSteps.has(event.step)) {
              return null;
            }
            // Render consensus event as standalone trace item
            if (event.type === 'model_plan' && event.stage === 'consensus') {
              return (
                <div key={`consensus-${event.step || index}`} className="agent-trace-item" data-type="consensus" data-stage="">
                  <span className="agent-trace-badge consensus">{t('agentPanel.voteBadge')}</span>
                  <div className="agent-trace-content consensus-content">
                    <div className="consensus-bar">
                      <span className="consensus-badge">
                        {event.consensus?.unanimous ? t('agentPanel.unanimous') : t('agentPanel.majority', { agreed: event.consensus?.agreed, total: event.consensus?.total })}
                      </span>
                      <span className="consensus-action">{event.consensus?.actionKey}</span>
                      <div className="consensus-votes">
                        {event.consensus?.allResults?.map(r => (
                          <span key={r.model} className={`consensus-vote ${r.actionKey === event.consensus?.actionKey ? 'agree' : 'dissent'}`}>
                            {getModelLabel(r.model, modelList)}: {r.actionKey}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            return (
            <div key={`${event.type}-${event.step || index}-${event.stage || index}`} className="agent-trace-item" data-type={event.type} data-stage={event.stage || ''}>
              {event.type === 'status' && (
                <>
                  <span className="agent-trace-badge">{t('agentPanel.badgeStatus')}</span>
                  <div className="agent-trace-content">
                    <strong>{event.message}</strong>
                  </div>
                </>
              )}

              {event.type === 'step' && event.stage === 'observe' && (
                <>
                  <span className="agent-trace-badge">{t('agentPanel.badgeObserve')}</span>
                  <div className="agent-trace-content">
                    <strong>Step {event.step}</strong>
                    {event.observation?.desktop?.frontmostApp && (
                      <p>
                        {t('agentPanel.desktop')}: {event.observation.desktop.frontmostApp}
                        {event.observation.desktop.frontmostWindowTitle ? ` · ${event.observation.desktop.frontmostWindowTitle}` : ''}
                      </p>
                    )}
                    {event.observation?.desktop?.screenshotPath && (() => {
                      const p = event.observation.desktop.screenshotPath;
                      const url = '/screenshots/' + p.split('desktop-agent-observations').pop()?.replace(/^\//, '');
                      return (
                        <img className="screenshot-img clickable" src={url} alt="screenshot" onClick={() => setLightboxSrc(url)} />
                      );
                    })()}
                    {event.observation?.browser?.title && <p>{event.observation.browser.title}</p>}
                    {event.observation?.browser?.url && <p className="agent-trace-url">{event.observation.browser.url}</p>}
                    {event.observation?.browser?.text && <p>{event.observation.browser.text}</p>}
                    {event.observation?.desktop?.windows?.length > 0 && (
                      <div className="agent-element-list">
                        {event.observation.desktop.windows.slice(0, 6).map((window, windowIndex) => (
                          <span key={`${window.app}-${window.title}-${windowIndex}`} className="agent-element-chip">
                            {window.app} {window.title || 'Untitled'}
                          </span>
                        ))}
                      </div>
                    )}
                    {event.observation?.browser?.elements?.length > 0 && (
                      <div className="agent-element-list">
                        {event.observation.browser.elements.slice(0, 6).map(element => (
                          <span key={element.id} className="agent-element-chip">
                            #{element.id} {element.tag} {element.text || element.href || ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {event.type === 'step' && event.stage === 'action' && (
                <>
                  <span className="agent-trace-badge action">{t('agentPanel.badgeAction')}</span>
                  <div className="agent-trace-content">
                    <div className="agent-step-header">
                      <strong>
                        Step {event.step} · {event.action?.tool || 'core'}.{event.action?.type}
                      </strong>
                      {event.usage && (
                        <span className="agent-token-badge">
                          {event.usage.prompt_tokens + event.usage.completion_tokens} tokens
                          <span className="agent-token-detail">
                            ↑{event.usage.prompt_tokens} ↓{event.usage.completion_tokens}
                          </span>
                        </span>
                      )}
                      <button className="trace-rollback-btn" onClick={(e) => { e.stopPropagation(); onRollback(event.step); }} disabled={rollbackLoading} title={t('agentPanel.rerunFromStep', { step: event.step })}>
                        <RotateCcw size={10} />
                      </button>
                    </div>
                    {event.rationale && <p>{event.rationale}</p>}
                    <pre className="agent-json">{JSON.stringify(event.action, null, 2)}</pre>
                  </div>
                </>
              )}

              {event.type === 'step' && event.stage === 'result' && (() => {
                const screenshotMatch = event.result?.match(/(?:\/[^\s\]]*)?\/(data\/screenshots|desktop-agent-observations)\/([^\s\]]+\.png)/);
                if (screenshotMatch) {
                  const url = '/screenshots/' + screenshotMatch[2];
                  return (
                    <>
                      <span className="agent-trace-badge result">{t('agentPanel.badgeResult')}</span>
                      <div className="agent-trace-content">
                        <strong>Step {event.step}</strong>
                        <img className="screenshot-img clickable" src={url} alt="screenshot" onClick={() => setLightboxSrc(url)} />
                      </div>
                    </>
                  );
                }
                return (
                  <>
                    <span className="agent-trace-badge result">{t('agentPanel.badgeResult')}</span>
                    <div className="agent-trace-content">
                      <strong>Step {event.step}</strong>
                      <p>{event.result}</p>
                    </div>
                  </>
                );
              })()}

              {event.type === 'done' && (
                <>
                  <span className="agent-trace-badge done">
                    {(event.quality?.status || event.meta?.status) === 'done_unverified'
                      ? t('agentPanel.doneBadgeUnverified')
                      : (event.quality?.status || event.meta?.status) === 'done_degraded'
                        ? t('agentPanel.statusDegraded')
                        : t('agentPanel.statusDone')}
                  </span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.agentDone')}</strong>
                    {event.meta?.step_count && <span className="agent-trace-meta">{t('agentPanel.stepCount', { n: event.meta.step_count })}</span>}
                    {event.quality?.reasons?.length > 0 && (
                      <p>{event.quality.reasons.join('；')}</p>
                    )}
                    {event.meta?.models_used?.length > 0 && (
                      <div className="agent-models-used">
                        {event.meta.models_used.map(m => {
                          const short = m.split('/').pop();
                          return <span key={m} className="agent-model-chip">{short}</span>;
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}

              {event.type === 'notification' && (
                <>
                  <span className={`agent-trace-badge ${event.level === 'warning' ? 'error' : event.level === 'discovery' ? 'approval' : 'result'}`}>
                    {event.level === 'warning' ? t('agentPanel.levelWarning') : event.level === 'discovery' ? t('agentPanel.levelDiscovery') : t('agentPanel.levelNotification')}
                  </span>
                  <div className="agent-trace-content">
                    <p>{event.message}</p>
                  </div>
                </>
              )}

              {event.type === 'user_response' && (
                <>
                  <span className="agent-trace-badge approval">{t('agentPanel.badgeAnswer')}</span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.userAnswer')}</strong>
                    <p style={{color: 'var(--c-text-muted)', fontSize: '12px'}}><em>{t('agentPanel.questionPrefix')}</em> {event.question}</p>
                    <p>{event.response}</p>
                  </div>
                </>
              )}

              {event.type === 'approval_required' && (
                <>
                  <span className="agent-trace-badge approval">{t('agentPanel.badgeApproval')}</span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.awaitingApproval', { step: event.step })}</strong>
                    <p>{event.message}</p>
                    <pre className="agent-json">{JSON.stringify(event.action, null, 2)}</pre>
                  </div>
                </>
              )}

              {event.type === 'approval_result' && (
                <>
                  <span className={`agent-trace-badge ${event.decision === 'approve' ? 'result' : 'error'}`}>{t('agentPanel.badgeApproval')}</span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.approvalResult', { step: event.step })}</strong>
                    <p>{event.message}</p>
                  </div>
                </>
              )}

              {event.type === 'error' && (
                <>
                  <span className="agent-trace-badge error">{t('agentPanel.badgeError')}</span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.agentFailed')}</strong>
                    <p>{event.error}</p>
                    {event.rollbackSuggestion && (() => {
                      const rs = event.rollbackSuggestion;
                      return (
                        <div className="rollback-suggestion">
                          <p className="rollback-suggestion-info">
                            {t('agentPanel.rollbackSuggest', { step: rs.step })}
                            {rs.lastAction && <span className="rollback-suggestion-detail">{t('agentPanel.lastStepDetail', { action: `${rs.lastAction.tool}.${rs.lastAction.type}` })}</span>}
                          </p>
                          {rs.lastRationale && <p className="rollback-suggestion-ctx">{t('agentPanel.decisionLabel', { text: rs.lastRationale })}</p>}
                          {rs.lastResult && <p className="rollback-suggestion-ctx">{t('agentPanel.resultLabel', { text: rs.lastResult })}</p>}
                          <button className="rollback-suggestion-btn" onClick={() => onRollback(rs.step)} disabled={rollbackLoading}>
                            <RotateCcw size={12} /> {t('agentPanel.rollbackTo', { step: rs.step })}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </>
              )}

              {event.type === 'rollback' && (
                <>
                  <span className="agent-trace-badge rollback">{t('agentPanel.badgeRollback')}</span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.rolledBackTo', { step: event.targetStep })}</strong>
                    <p>{event.message}</p>
                  </div>
                </>
              )}

              {event.type === 'session_checkpoint' && (
                <>
                  <span className="agent-trace-badge plan">{t('agentPanel.badgeSnapshot')}</span>
                  <div className="agent-trace-content">
                    <strong>{t('agentPanel.snapshotSaved', { step: event.step })}</strong>
                  </div>
                </>
              )}
            </div>
            );
          })})()}
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
