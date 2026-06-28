import { ChevronDown, ChevronRight } from 'lucide-react';
import { actionTitle } from './action-summary.js';
import { ToolIcon } from './tool-icon.jsx';

const HIDDEN_KEYS = new Set(['tool', 'type']);

function formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ActionDetails({ action, jsonOpen, onToggleJson, t }) {
  if (!action || typeof action !== 'object') return null;

  const params = Object.entries(action).filter(([key, value]) => {
    if (HIDDEN_KEYS.has(key)) return false;
    return value != null && value !== '';
  });

  return (
    <div className="tool-request-details">
      <div className="tool-request-row">
        <span className="tool-request-label">{t('agentPanel.requestTool')}</span>
        <span className="tool-request-tool" data-tool={action.tool || undefined}>
          <ToolIcon tool={action.tool} size={13} />
          <code>{actionTitle(action)}</code>
        </span>
      </div>

      <div className="tool-request-row align-start">
        <span className="tool-request-label">{t('agentPanel.requestContent')}</span>
        <div className="tool-request-content">
          {params.length > 0 ? (
            params.map(([key, value]) => (
              <div className="tool-request-param" key={key}>
                <span className="tool-request-param-key">{key}</span>
                <pre className="tool-request-param-value">{formatValue(value)}</pre>
              </div>
            ))
          ) : (
            <span className="tool-request-empty">{t('agentPanel.noRequestContent')}</span>
          )}
        </div>
      </div>

      <button className="step-card-json-toggle tool-request-json-toggle" onClick={onToggleJson}>
        {jsonOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {t('agentPanel.showJson')}
      </button>
      {jsonOpen && <pre className="agent-json">{JSON.stringify(action, null, 2)}</pre>}
    </div>
  );
}
