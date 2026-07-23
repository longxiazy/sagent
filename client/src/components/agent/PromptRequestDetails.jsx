import { useState } from 'react';
import { buildPromptDiff } from '../../utils/prompt-diff.js';

const FOLD_CONTEXT = 3;

function formatRequest(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// 未改动段：超过 2×context+1 行时折叠中间，仅保留首尾 context 行作为定位上下文。
function EqualBlock({ text, t }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  if (lines.length <= FOLD_CONTEXT * 2 + 1) {
    return <span className="prompt-word same">{text}</span>;
  }
  if (expanded) {
    return (
      <>
        <span className="prompt-word same">{text}</span>
        <button type="button" className="prompt-fold-band" onClick={() => setExpanded(false)}>
          {t('agentPanel.requestFoldCollapse')}
        </button>
      </>
    );
  }
  const hiddenCount = lines.length - FOLD_CONTEXT * 2;
  return (
    <>
      <span className="prompt-word same">{lines.slice(0, FOLD_CONTEXT).join('\n')}</span>
      <button type="button" className="prompt-fold-band" onClick={() => setExpanded(true)}>
        {t('agentPanel.requestFolded', { n: hiddenCount })}
      </button>
      <span className="prompt-word same">{lines.slice(-FOLD_CONTEXT).join('\n')}</span>
    </>
  );
}

function PromptDiff({ currentText, previousText, t }) {
  const { hasPrevious, blocks } = buildPromptDiff(previousText, currentText);
  return (
    <>
      {hasPrevious && <div className="prompt-request-diff-legend">{t('agentPanel.requestDiffLegend')}</div>}
      <pre className="prompt-request-pre prompt-word-diff">
        {blocks.map((block, index) => {
          if (block.type === 'change') {
            return block.segments.map((seg, segIndex) => (
              <span key={`c-${index}-${segIndex}`} className={`prompt-word ${seg.op}`}>{seg.value}</span>
            ));
          }
          return <EqualBlock key={`e-${index}`} text={block.text} t={t} />;
        })}
      </pre>
    </>
  );
}

export function PromptRequestDetails({ requests, previousRequest, response, reasoning, t }) {
  const [open, setOpen] = useState(false);
  const [requestIndex, setRequestIndex] = useState(0);
  const requestList = Array.isArray(requests) ? requests : [];
  const activeIndex = Math.min(requestIndex, Math.max(requestList.length - 1, 0));
  const currentRequest = requestList.length > 0 ? requestList[activeIndex] : null;
  const currentText = formatRequest(currentRequest);
  // 仅首个尝试与上一轮请求对比；重试尝试之间不做 diff（各自完整展示）。
  const previousText = activeIndex === 0 ? formatRequest(previousRequest) : '';
  const responseText = formatRequest(response);

  if (!currentRequest && !responseText && !reasoning) return null;

  return (
    <div className="prompt-request-details">
      <button className="prompt-request-toggle" onClick={() => setOpen(value => !value)}>
        {open ? '▾' : '▸'} {t('agentPanel.viewLlmExchange')}
        {requestList.length > 1 ? ` · ${t('agentPanel.requestAttempts', { n: requestList.length })}` : ''}
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
          {currentRequest && (
            <section className="prompt-exchange-section">
              <div className="prompt-exchange-label">{t('agentPanel.llmRequest')}</div>
              <PromptDiff currentText={currentText} previousText={previousText} t={t} />
            </section>
          )}
          {(responseText || reasoning) && (
            <section className="prompt-exchange-section prompt-response-section">
              <div className="prompt-exchange-label">{t('agentPanel.llmResponse')}</div>
              {reasoning && (
                <>
                  <div className="prompt-response-kind">{t('modelCard.reasoning')}</div>
                  <pre className="prompt-request-pre prompt-response-pre">{reasoning}</pre>
                </>
              )}
              {responseText && <pre className="prompt-request-pre prompt-response-pre">{responseText}</pre>}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
