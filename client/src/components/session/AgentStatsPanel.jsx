import { BarChart3, Bot, Clock3, Coins, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { buildAgentStats } from '../../utils/agent-stats.js';
import { formatFullTime, formatRelativeTime } from '../../utils/format.js';
import { formatDurationMs, formatTokenCount } from '../agent/trace-metrics.js';
import { useT } from '../../i18n/I18nProvider.jsx';

function modelLabel(modelId, modelList) {
  return modelList.find(item => item.id === modelId)?.label || modelId;
}

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

function StatTile({ icon, value, label }) {
  return (
    <div className="agent-stats-tile">
      <span className="agent-stats-tile-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TokenChart({ dailyData }) {
  const maxTokens = Math.max(1, ...dailyData.map(item => item.tokens || 0));
  const width = 280;
  const height = 96;
  const chartTop = 8;
  const chartHeight = 60;
  const slot = width / Math.max(1, dailyData.length);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="agent-token-chart" role="img">
      {dailyData.map((item, index) => {
        const barHeight = Math.max(item.tokens > 0 ? 3 : 0, (item.tokens / maxTokens) * chartHeight);
        const x = index * slot + 5;
        const y = chartTop + chartHeight - barHeight;
        const label = item.date.slice(5);
        return (
          <g key={item.date}>
            <rect
              x={x}
              y={y}
              width={Math.max(8, slot - 10)}
              height={barHeight}
              rx="3"
              fill={item.tokens > 0 ? 'var(--c-primary)' : 'var(--c-surface-inline)'}
            />
            <text x={index * slot + slot / 2} y="84" textAnchor="middle">{label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function AgentStatsPanel({ sessions, modelList = [], onSelectSession, locked }) {
  const t = useT();
  const stats = useMemo(() => buildAgentStats(sessions), [sessions]);
  const hasRuns = stats.totalRuns > 0;
  const maxTokens = Math.max(...stats.dailyData.map(item => item.tokens || 0));

  return (
    <div className="agent-stats-panel">
      <div className="agent-stats-hero">
        <div>
          <p className="agent-stats-eyebrow">{t('agentStats.eyebrow')}</p>
          <h3>{t('agentStats.title')}</h3>
        </div>
        <BarChart3 size={18} />
      </div>

      <div className="agent-stats-grid">
        <StatTile icon={<Zap size={14} />} value={stats.todayRuns} label={t('agentStats.tasks')} />
        <StatTile icon={<Clock3 size={14} />} value={formatDurationMs(stats.todayElapsedMs)} label={t('agentStats.elapsed')} />
        <StatTile icon={<Coins size={14} />} value={formatTokenCount(stats.todayTokens)} label={t('agentStats.tokens')} />
        <StatTile icon={<Bot size={14} />} value={stats.todayModelCount} label={t('agentStats.models')} />
      </div>

      <section className="agent-stats-section">
        <div className="agent-stats-section-head">
          <h4>{t('agentStats.recentRuns')}</h4>
          <span>{t('agentStats.totalRuns', { n: stats.totalRuns })}</span>
        </div>
        {stats.recentRuns.length === 0 ? (
          <div className="agent-stats-empty">{t('agentStats.empty')}</div>
        ) : (
          <div className="agent-stats-runs">
            {stats.recentRuns.map(run => {
              const models = run.models.map(model => modelLabel(model, modelList));
              const title = run.task || t('agent.taskFallback');
              return (
                <button
                  key={`${run.sessionId}-${run.runId || run.endedAt || title}`}
                  className="agent-stats-run"
                  onClick={() => onSelectSession?.(run.sessionId)}
                  disabled={locked}
                  title={run.endedAt ? formatFullTime(run.endedAt) : title}
                >
                  <span className="agent-stats-run-title">{title}</span>
                  <span className="agent-stats-run-meta">
                    {formatDurationMs(run.elapsedMs)} · {formatTokenCount(run.totalTokens)} tok · {run.stepCount} {t('agentStats.steps')}
                  </span>
                  <span className="agent-stats-run-foot">
                    <span>{models.slice(0, 2).join(' + ') || t('session.unknownModel')}</span>
                    <span>{run.endedAt ? formatRelativeTime(run.endedAt) : statusLabel(run.status, t)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="agent-stats-section">
        <div className="agent-stats-section-head">
          <h4>{t('agentStats.trend')}</h4>
          <span>{maxTokens > 0 ? `${formatTokenCount(maxTokens)} tok` : t('agentStats.noTokens')}</span>
        </div>
        <TokenChart dailyData={stats.dailyData} />
      </section>

      {hasRuns && (
        <section className="agent-stats-section agent-stats-summary">
          <div>
            <span>{t('agentStats.allTimeTokens')}</span>
            <strong>{formatTokenCount(stats.totalTokens)} tok</strong>
          </div>
          <div>
            <span>{t('agentStats.allTimeElapsed')}</span>
            <strong>{formatDurationMs(stats.totalElapsedMs)}</strong>
          </div>
          <div>
            <span>{t('agentStats.strategy')}</span>
            <strong>{strategyLabel(stats.recentRuns[0]?.strategy, t)}</strong>
          </div>
        </section>
      )}
    </div>
  );
}
