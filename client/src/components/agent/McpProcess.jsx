import { Check, CircleAlert, LoaderCircle, PlugZap } from 'lucide-react';

export function McpProcess({ events = [], running = false, t }) {
  if (!events.length) return null;
  const latest = events[events.length - 1];
  const active = running && latest.phase !== 'completed' && latest.phase !== 'error';
  const percent = Number.isFinite(latest.progress) && Number.isFinite(latest.total) && latest.total > 0
    ? Math.min(100, Math.max(0, Math.round(latest.progress / latest.total * 100)))
    : null;

  return (
    <div className={`mcp-process ${latest.phase === 'error' ? 'error' : ''}`}>
      <div className="mcp-process-head">
        {latest.phase === 'error'
          ? <CircleAlert size={13} />
          : active
            ? <LoaderCircle size={13} className="mcp-process-spinner" />
            : latest.phase === 'completed'
              ? <Check size={13} />
              : <PlugZap size={13} />}
        <strong>{latest.serverName}{latest.toolName ? ` / ${latest.toolName}` : ''}</strong>
        <span>{t(`agentPanel.mcpPhase.${latest.phase}`)}</span>
        {percent != null && <span className="mcp-process-percent">{percent}%</span>}
      </div>
      {latest.message && <p>{latest.message}</p>}
    </div>
  );
}
