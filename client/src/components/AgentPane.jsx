import { useT } from '../i18n/I18nProvider.jsx';

function getAgentStepMetrics(trace) {
  const lastStep = trace.reduce((max, event) => (event.step != null ? Math.max(max, event.step) : max), 0);
  const totalTokens = trace.reduce((sum, event) => {
    if (event.type === 'step' && event.stage === 'action' && event.usage) {
      return sum + event.usage.prompt_tokens + event.usage.completion_tokens;
    }
    return sum;
  }, 0);
  const doneEvent = [...trace].reverse().find(event => event.type === 'done');
  return {
    lastStep,
    totalTokens,
    stepCount: doneEvent?.meta?.step_count || lastStep,
  };
}

function formatTokenCount(value) {
  return value > 999 ? `${(value / 1000).toFixed(1)}k` : value;
}

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
  const metrics = getAgentStepMetrics(agentTrace);

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
        <button className={`agent-mobile-tab ${agentMobileTab === 'chat' ? 'active' : ''}`} onClick={() => setAgentMobileTab('chat')}>{t('mode.chat')}</button>
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
