import { BarChart3, Bot, Clock3, Coins, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { buildAgentStats } from '../../utils/agent-stats.js';
import { formatDurationMs, formatTokenCount } from '../agent/trace-metrics.js';
import { useT } from '../../i18n/I18nProvider.jsx';

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

export function AgentStatsPanel({ sessions }) {
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
            <span>{t('agentStats.allTimeRuns')}</span>
            <strong>{stats.totalRuns}</strong>
          </div>
        </section>
      )}
    </div>
  );
}
