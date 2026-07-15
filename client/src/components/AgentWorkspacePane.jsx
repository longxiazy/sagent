import { Fragment } from 'react';
import { AgentComposer } from './AgentComposer.jsx';
import { lastUserMessageIndex } from '../utils/agent-workspace.js';

function formatMessageModels(message, getModelLabel) {
  const ids = Array.isArray(message.modelsUsed) && message.modelsUsed.length > 0
    ? message.modelsUsed
    : message.model
      ? [message.model]
      : [];
  const labels = ids.map(id => getModelLabel?.(id) || id).filter(Boolean);
  if (labels.length <= 2) return labels.join(' + ');
  return `${labels.slice(0, 2).join(' + ')} +${labels.length - 2}`;
}

export function AgentWorkspacePane({
  messages,
  agentPanel,
  streaming,
  bottomRef,
  textareaRef,
  inputValue,
  setInput,
  handleKeyDown,
  placeholder,
  disabled,
  sendButton,
  attachButton,
  attachmentBar,
  contextMeter,
  renderMessageContent,
  renderCopyButton,
  hasThinkContent,
  getModelLabel,
  formatMsgTime,
}) {
  const traceAfterIndex = lastUserMessageIndex(messages);

  const renderAgentPanel = key => agentPanel ? (
    <div className="agent-workspace-trace" key={key}>
      {agentPanel}
    </div>
  ) : null;

  return (
    <div className="agent-workspace-pane">
      <div className="messages agent-workspace-messages">
        {traceAfterIndex < 0 && renderAgentPanel('agent-trace-before-messages')}
        {messages.map((message, index) => {
          const messageModelLabel = message.role === 'assistant' ? formatMessageModels(message, getModelLabel) : '';
          const hidePendingRun = message.role === 'assistant' && message.pending === 'run' && agentPanel;
          return (
            <Fragment key={index}>
              {!hidePendingRun && (
                <div className={`bubble-row ${message.role}`}>
                  {message.role === 'assistant' && (
                    <>
                      <div className={`bubble assistant ${hasThinkContent(message.content) ? 'has-think' : ''}`}>
                        {renderMessageContent({ role: 'assistant', content: message.content, showCursor: streaming && index === messages.length - 1 })}
                        {(messageModelLabel || message.ts) && (
                          <div className="msg-meta">
                            {messageModelLabel && <span className="msg-model" title={messageModelLabel}>{messageModelLabel}</span>}
                            {message.ts && <span className="msg-time">{formatMsgTime(message.ts)}</span>}
                          </div>
                        )}
                      </div>
                      {renderCopyButton({ text: message.content })}
                    </>
                  )}
                  {message.role === 'user' && (
                    <>
                      {renderCopyButton({ text: message.content })}
                      <div className="bubble user">
                        {renderMessageContent({ role: 'user', content: message.content })}
                        {message.ts && <div className="msg-time">{formatMsgTime(message.ts)}</div>}
                      </div>
                    </>
                  )}
                </div>
              )}
              {index === traceAfterIndex && renderAgentPanel(`agent-trace-after-${index}`)}
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
        <div className="input-area">
          <AgentComposer
            variant="dock"
            value={inputValue}
            setValue={setInput}
            textareaRef={textareaRef}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            disabled={disabled}
            attachButton={attachButton}
            sendButton={sendButton}
            attachmentBar={attachmentBar}
            contextMeter={contextMeter}
          />
        </div>
      </div>
    </div>
  );
}
