import { Loader2 } from 'lucide-react';

const MAX_CHUNK_CHARS = 4000;

function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function trimChunk(text) {
  const value = String(text || '');
  return value.length > MAX_CHUNK_CHARS ? `${value.slice(0, MAX_CHUNK_CHARS)}\n...[truncated]` : value;
}

export function TerminalProcess({ events = [], running = false, t }) {
  if (!events.length) return null;

  const latest = events[events.length - 1];
  const isOpen = running && !['exit', 'error', 'timeout'].includes(latest.phase);
  const outputEvents = events.filter(event => event.phase === 'stdout' || event.phase === 'stderr');
  const endEvent = events.findLast?.(event => ['exit', 'error', 'timeout'].includes(event.phase))
    || [...events].reverse().find(event => ['exit', 'error', 'timeout'].includes(event.phase));

  return (
    <div className="terminal-process">
      <div className="terminal-process-head">
        <span className="terminal-process-label">{t('agentPanel.executionProcess')}</span>
        {isOpen ? (
          <span className="terminal-process-status running">
            <Loader2 size={10} /> {t('agentPanel.terminalRunning')}
          </span>
        ) : endEvent?.phase === 'exit' ? (
          <span className={`terminal-process-status ${endEvent.exitCode === 0 ? 'success' : 'error'}`}>
            {t('agentPanel.terminalExitCode', { code: endEvent.exitCode ?? '?' })}
            {endEvent.elapsedMs != null ? ` · ${formatElapsed(endEvent.elapsedMs)}` : ''}
          </span>
        ) : endEvent ? (
          <span className="terminal-process-status error">
            {endEvent.phase === 'timeout' ? t('agentPanel.terminalTimeout') : t('agentPanel.terminalError')}
            {endEvent.elapsedMs != null ? ` · ${formatElapsed(endEvent.elapsedMs)}` : ''}
          </span>
        ) : null}
      </div>

      {outputEvents.length > 0 ? (
        <div className="terminal-process-stream">
          {outputEvents.map((event, index) => (
            <div className={`terminal-process-line ${event.phase}`} key={`${event.phase}-${index}`}>
              <span className="terminal-process-stream-label">{event.phase}</span>
              <pre>{trimChunk(event.chunk)}</pre>
            </div>
          ))}
        </div>
      ) : (
        <div className="terminal-process-empty">
          {isOpen ? t('agentPanel.terminalNoOutputYet') : t('agentPanel.terminalNoOutput')}
        </div>
      )}

      {endEvent?.message && <p className="terminal-process-message">{endEvent.message}</p>}
    </div>
  );
}
