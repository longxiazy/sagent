import { Activity, BarChart3 } from 'lucide-react';
import { formatDurationMs, formatTokenCount } from './trace-metrics.js';

function formatRate(value) {
  if (value == null) return '--';
  return `${Math.round(value * 100)}%`;
}

function MetricCell({ label, value, tone }) {
  return (
    <div className={`trace-debug-metric${tone ? ` ${tone}` : ''}`}>
      <span className="trace-debug-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function TraceDebugPanel({ metrics, t }) {
  const steps = metrics.stepDurations || [];
  const visibleSteps = steps.slice(-12);
  const maxDuration = Math.max(1, ...visibleSteps.map(step => step.durationMs || 0));
  const slowest = metrics.slowestStep;

  return (
    <details className="trace-debug-panel">
      <summary className="trace-debug-summary">
        <span className="trace-debug-title">
          <Activity size={13} />
          {t('agentPanel.traceDebug')}
        </span>
        <span className="trace-debug-summary-meta">
          {t('agentPanel.traceDebugMeta', {
            llm: metrics.llmCalls,
            tools: metrics.completedToolCalls,
          })}
        </span>
      </summary>

      <div className="trace-debug-grid">
        <MetricCell label={t('agentPanel.metricLlmCalls')} value={metrics.llmCalls} />
        <MetricCell label={t('agentPanel.metricTokens')} value={formatTokenCount(metrics.totalTokens)} tone="tokens" />
        <MetricCell label={t('agentPanel.metricToolSuccess')} value={formatRate(metrics.toolSuccessRate)} tone={metrics.toolFailures > 0 ? 'warn' : 'ok'} />
        <MetricCell label={t('agentPanel.metricAvgStep')} value={formatDurationMs(metrics.avgStepMs)} />
        <MetricCell label={t('agentPanel.metricSlowestStep')} value={slowest ? `Step ${slowest.step} · ${formatDurationMs(slowest.durationMs)}` : '--'} tone={slowest?.status === 'failed' || slowest?.status === 'slow' ? 'warn' : ''} />
      </div>

      {visibleSteps.length > 0 && (
        <div className="trace-debug-bars" aria-label={t('agentPanel.stepLatency')}>
          <div className="trace-debug-bars-head">
            <span>
              <BarChart3 size={12} />
              {t('agentPanel.stepLatency')}
            </span>
            <span>{formatDurationMs(metrics.totalDurationMs)}</span>
          </div>
          {visibleSteps.map(step => (
            <div className="trace-debug-bar-row" key={step.step}>
              <span className="trace-debug-step">S{step.step}</span>
              <div className="trace-debug-bar-track">
                <span
                  className={`trace-debug-bar ${step.status}`}
                  style={{ width: `${Math.max(4, Math.round((step.durationMs / maxDuration) * 100))}%` }}
                />
              </div>
              <span className="trace-debug-duration">{formatDurationMs(step.durationMs)}</span>
              {step.tokens > 0 && <span className="trace-debug-tokens">{formatTokenCount(step.tokens)} tok</span>}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
