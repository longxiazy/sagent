import { useT } from '../i18n/I18nProvider.jsx';
import { computeTraceMetrics, formatTokenCount } from './agent/trace-metrics.js';

export function AgentPane({
  agentMobileTab,
  setAgentMobileTab,
  agentRunning,
  agentTrace,
  touchStartRef,
  agentPanel,
  resizeDivider,
}) {
  const t = useT();
  const metrics = computeTraceMetrics(agentTrace);

  return (
    <>
      <div className="agent-mobile-tabs">
        <button className={`agent-mobile-tab ${agentMobileTab === 'agent' ? 'active' : ''}`} onClick={() => setAgentMobileTab('agent')}>
          Agent{agentRunning && <span className="tab-status-dot" />}
        </button>
        {agentTrace.length > 0 && (
          <div className="agent-mobile-metrics">
            {metrics.lastStep > 0 && <span className="agent-mobile-metric">Step {metrics.lastStep}/{metrics.stepCount}</span>}
            {metrics.totalTokens > 0 && <span className="agent-mobile-metric">{formatTokenCount(metrics.totalTokens)} tok</span>}
          </div>
        )}
        <button className={`agent-mobile-tab ${agentMobileTab === 'chat' ? 'active' : ''}`} onClick={() => setAgentMobileTab('chat')}>{t('agent.conversationTab')}</button>
      </div>
      <div
        className={`agent-panel-wrap ${agentMobileTab === 'chat' ? 'mobile-hidden' : ''}`}
        onTouchStart={event => { touchStartRef.current = event.touches[0].clientX; }}
        onTouchEnd={event => {
          if (touchStartRef.current == null) return;
          const delta = event.changedTouches[0].clientX - touchStartRef.current;
          if (delta < -60 && agentMobileTab === 'agent') setAgentMobileTab('chat');
          touchStartRef.current = null;
        }}
      >
        {agentPanel}
      </div>

      {resizeDivider}
    </>
  );
}
