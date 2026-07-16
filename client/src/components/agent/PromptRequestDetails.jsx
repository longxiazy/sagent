import { useMemo, useState } from 'react';

function formatRequest(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function changedLines(currentText, previousText) {
  const current = currentText.split('\n');
  if (!previousText) return current.map(text => ({ text, changed: false }));
  const previous = new Set(previousText.split('\n'));
  return current.map(text => ({ text, changed: !previous.has(text) }));
}

export function PromptRequestDetails({ requests, previousRequest, t }) {
  const [open, setOpen] = useState(false);
  const [requestIndex, setRequestIndex] = useState(0);
  const requestList = Array.isArray(requests) ? requests : [];
  const activeIndex = Math.min(requestIndex, Math.max(requestList.length - 1, 0));
  const currentRequest = requestList.length > 0 ? requestList[activeIndex] : null;
  const currentText = useMemo(() => formatRequest(currentRequest), [currentRequest]);
  const previousText = useMemo(() => formatRequest(previousRequest), [previousRequest]);
  const lines = useMemo(() => changedLines(currentText, previousText), [currentText, previousText]);
  const removedLines = useMemo(() => {
    if (!previousText) return [];
    const current = new Set(currentText.split('\n'));
    return previousText.split('\n').filter(text => !current.has(text));
  }, [currentText, previousText]);

  if (!currentRequest) return null;

  return (
    <div className="prompt-request-details">
      <button className="prompt-request-toggle" onClick={() => setOpen(value => !value)}>
        {open ? '▾' : '▸'} {t('agentPanel.viewLlmRequest')}
        {requests.length > 1 ? ` · ${t('agentPanel.requestAttempts', { n: requests.length })}` : ''}
      </button>
      {open && (
        <div className="prompt-request-body">
          {requestList.length > 1 && (
            <div className="prompt-request-attempts">
              {requestList.map((_, index) => (
                <button key={index} className={activeIndex === index ? 'active' : ''} onClick={() => setRequestIndex(index)}>
                  {t('agentPanel.requestAttempt', { n: index + 1 })}
                </button>
              ))}
            </div>
          )}
          {previousText && <div className="prompt-request-diff-legend">{t('agentPanel.requestDiffLegend')}</div>}
          <pre className="prompt-request-pre">
            {lines.map((line, index) => (
              <span key={`current-${index}`} className={line.changed ? 'prompt-request-line changed' : 'prompt-request-line'}>{line.text}{'\n'}</span>
            ))}
          </pre>
          {removedLines.length > 0 && (
            <details className="prompt-request-removed">
              <summary>{t('agentPanel.requestRemoved', { n: removedLines.length })}</summary>
              <pre className="prompt-request-pre">
                {removedLines.map((line, index) => <span key={`removed-${index}`} className="prompt-request-line removed">{line}{'\n'}</span>)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
