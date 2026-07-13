import { BarChart3 } from 'lucide-react';
import { computeModelTraceMetrics, formatDurationMs, formatTokenCount } from './trace-metrics.js';
import { getModelLabel } from './plan-stage.js';

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

export function TraceDebugPanel({ metrics, trace = [], selectedModelId = 'all', modelList = [], t }) {
  const modelMetrics = computeModelTraceMetrics(trace);
  const selectedMetrics = selectedModelId === 'all' ? null : modelMetrics.find(item => item.modelId === selectedModelId);
  const steps = metrics.stepDurations || [];
  const visibleSteps = steps.slice(-12);
  const maxDuration = Math.max(1, ...visibleSteps.map(step => step.durationMs || 0));
  const slowest = metrics.slowestStep;

  const visibleModelMetrics = selectedMetrics ? [selectedMetrics] : modelMetrics;

  return (
    <div className="trace-debug-panel trace-debug-panel--dialog">
      <div className="trace-debug-grid">
        <MetricCell label={t('agentPanel.metricLlmCalls')} value={metrics.llmCalls} />
        <MetricCell label={t('agentPanel.metricTokens')} value={formatTokenCount(metrics.totalTokens)} tone="tokens" />
        <MetricCell label={t('agentPanel.metricToolSuccess')} value={formatRate(metrics.toolSuccessRate)} tone={metrics.toolFailures > 0 ? 'warn' : 'ok'} />
        <MetricCell label={t('agentPanel.metricAvgStep')} value={formatDurationMs(metrics.avgStepMs)} />
        <MetricCell label={t('agentPanel.metricSlowestStep')} value={slowest ? `Step ${slowest.step} · ${formatDurationMs(slowest.durationMs)}` : '--'} tone={slowest?.status === 'failed' || slowest?.status === 'slow' ? 'warn' : ''} />
      </div>

      {visibleModelMetrics.length > 0 && (
        <div className="trace-debug-model-list">
          {visibleModelMetrics.map(item => (
            <div className="trace-debug-model-section" key={item.modelId}>
              <strong>{getModelLabel(item.modelId, modelList)}</strong>
              <div className="trace-debug-grid">
                <MetricCell label={t('agentPanel.metricLlmCalls')} value={item.llmCalls} />
                <MetricCell label={t('agentPanel.metricTokens')} value={formatTokenCount(item.totalTokens)} tone="tokens" />
                <MetricCell label={t('agentPanel.metricWins')} value={item.wins} tone="ok" />
                <MetricCell label={t('agentPanel.metricFailures')} value={item.failures} tone={item.failures ? 'warn' : ''} />
                <MetricCell label={t('agentPanel.metricAvgDecision')} value={formatDurationMs(item.avgDurationMs)} />
              </div>
            </div>
          ))}
        </div>
      )}

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
    </div>
  );
}
