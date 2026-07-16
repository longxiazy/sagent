import { memo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { getModelLabel } from './plan-stage.js';
import { ActionDetails } from './ActionDetails.jsx';
import { TerminalProcess } from './TerminalProcess.jsx';
import { McpProcess } from './McpProcess.jsx';
import { summarizeAction } from './action-summary.js';

// 单条 trace 渲染。从 AgentPanel 平移而来并用 memo 包裹：trace 是 append-only 的，
// 旧 event 对象引用不变，新事件到达时已渲染过的 item 不会重跑（尤其是 action 里的
// JSON.stringify）。回调(onRollback/openLightbox)与 t 在上层均已稳定化，memo 才有效。
export const TraceItem = memo(function TraceItem({ event, selectedModelId = 'all', modelList, onRollback, rollbackLoading, openLightbox, t }) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const toggleJson = e => { e?.stopPropagation?.(); setJsonOpen(v => !v); };

  // 投票模式的 consensus 作为独立 trace 项展示。
  if (event.type === 'model_plan' && event.stage === 'consensus') {
    return (
      <div className="agent-trace-item" data-type="consensus" data-stage="">
        <span className="agent-trace-badge consensus">{t('agentPanel.voteBadge')}</span>
        <div className="agent-trace-content consensus-content">
          <div className="consensus-bar">
            <span className="consensus-badge">
              {event.consensus?.unanimous ? t('agentPanel.unanimous') : t('agentPanel.majority', { agreed: event.consensus?.agreed, total: event.consensus?.total })}
            </span>
            <span className="consensus-action">{event.consensus?.actionKey}</span>
            <div className="consensus-votes">
              {event.consensus?.allResults?.filter(r => selectedModelId === 'all' || r.model === selectedModelId).map(r => (
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
    <div className="agent-trace-item" data-type={event.type} data-stage={event.stage || ''} data-tool={event.action?.tool || undefined} data-status={event.type === 'done' ? (event.quality?.status || event.meta?.status || undefined) : undefined}>
      {event.type === 'status' && (
        <>
          <span className="agent-trace-badge">{t('agentPanel.badgeStatus')}</span>
          <div className="agent-trace-content">
            <strong>{event.message}</strong>
          </div>
        </>
      )}

      {event.type === 'browser_session' && (
        <>
          <span className={`agent-trace-badge ${event.status === 'degraded' ? 'error' : 'approval'}`}>{t('agentPanel.browserBadge')}</span>
          <div className="agent-trace-content">
            <strong>{t(`agentPanel.browserStatus.${event.status}`)}</strong>
            <p>{event.url || event.reason || ''}{event.sessionId ? ` · Session #${event.sessionId}` : ''}</p>
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
                <img className="screenshot-thumb clickable" src={url} alt="screenshot" onClick={() => openLightbox(url)} />
              );
            })()}
            {event.observation?.browser?.title && <p>{event.observation.browser.title}</p>}
            {event.observation?.browser?.url && <p className="agent-trace-url">{event.observation.browser.url}</p>}
            {event.observation?.browser?.text && <p>{event.observation.browser.text}</p>}
            {event.observation?.desktop?.windows?.length > 0 && (
              <details className="agent-observe-details">
                <summary>{t('agentPanel.moreDetails', { n: event.observation.desktop.windows.length })}</summary>
                <div className="agent-element-list">
                  {event.observation.desktop.windows.slice(0, 6).map((window, windowIndex) => (
                    <span key={`${window.app}-${window.title}-${windowIndex}`} className="agent-element-chip">
                      {window.app} {window.title || 'Untitled'}
                    </span>
                  ))}
                </div>
              </details>
            )}
            {event.observation?.browser?.elements?.length > 0 && (
              <details className="agent-observe-details">
                <summary>{t('agentPanel.moreDetails', { n: event.observation.browser.elements.length })}</summary>
                <div className="agent-element-list">
                  {event.observation.browser.elements.slice(0, 6).map(element => (
                    <span key={element.id} className="agent-element-chip">
                      #{element.id} {element.tag} {element.text || element.href || ''}
                    </span>
                  ))}
                </div>
              </details>
            )}
          </div>
        </>
      )}

      {event.type === 'step' && event.stage === 'action' && (
        <>
          <span className="agent-trace-badge action">{t('agentPanel.badgeAction')}</span>
          <div className="agent-trace-content">
            <div className="agent-step-header">
              <strong>{summarizeAction(event.action, event.rationale)}</strong>
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
            <ActionDetails action={event.action} jsonOpen={jsonOpen} onToggleJson={toggleJson} t={t} />
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
                <img className="screenshot-thumb clickable" src={url} alt="screenshot" onClick={() => openLightbox(url)} />
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
            <ActionDetails action={event.action} jsonOpen={jsonOpen} onToggleJson={toggleJson} t={t} />
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

      {event.type === 'terminal_output' && (
        <>
          <span className="agent-trace-badge result">{t('agentPanel.badgeTerminal')}</span>
          <div className="agent-trace-content">
            <TerminalProcess events={[event]} running={event.phase !== 'exit'} t={t} />
          </div>
        </>
      )}

      {event.type === 'mcp_output' && (
        <div className="agent-trace-content">
          <McpProcess events={[event]} running={event.phase !== 'completed' && event.phase !== 'error'} t={t} />
        </div>
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
});
