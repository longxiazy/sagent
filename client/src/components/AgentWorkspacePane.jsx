import { Fragment, useRef } from 'react';
import { AgentComposer } from './AgentComposer.jsx';
import { useElementHeightVar } from '../hooks/useElementHeightVar.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { lastUserMessageIndex } from '../utils/agent-workspace.js';

// 与 CSS 里输入框改为浮层的断点保持一致。
const FLOATING_COMPOSER_BREAKPOINT = 640;

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
  modelSelect,
  attachButton,
  privateModeToggle,
  memoryToggle,
  attachmentBar,
  contextMeter,
  renderMessageContent,
  renderCopyButton,
  hasThinkContent,
  getModelLabel,
  formatMsgTime,
}) {
  const composerRef = useRef(null);
  const isMobile = useIsMobile(FLOATING_COMPOSER_BREAKPOINT);
  // 窄屏下输入框浮在消息流之上，消息区靠这个变量预留等高的底部空间。
  useElementHeightVar(composerRef, '--composer-height', { enabled: isMobile });

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
      </div>
      <div className="agent-workspace-composer" ref={composerRef}>
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
            modelSelect={modelSelect}
            attachButton={attachButton}
            privateModeToggle={privateModeToggle}
            memoryToggle={memoryToggle}
            sendButton={sendButton}
            attachmentBar={attachmentBar}
            contextMeter={contextMeter}
          />
        </div>
      </div>
    </div>
  );
}
