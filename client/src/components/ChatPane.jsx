export function ChatPane({
  hidden,
  messages,
  streaming,
  bottomRef,
  textareaRef,
  inputValue,
  setInput,
  handleKeyDown,
  placeholder,
  disabled,
  memoryToggle,
  sendButton,
  touchStartRef,
  agentMobileTab,
  setAgentMobileTab,
  renderMessageContent,
  renderCopyButton,
  hasThinkContent,
  formatMsgTime,
}) {
  return (
    <div
      className={`chat-panel-wrap ${hidden ? 'mobile-hidden' : ''}`}
      onTouchStart={event => { touchStartRef.current = event.touches[0].clientX; }}
      onTouchEnd={event => {
        if (touchStartRef.current == null) return;
        const delta = event.changedTouches[0].clientX - touchStartRef.current;
        if (delta > 60 && agentMobileTab === 'chat') setAgentMobileTab('agent');
        touchStartRef.current = null;
      }}
    >
      <div className="messages">
        {messages.map((message, index) => (
          <div key={index} className={`bubble-row ${message.role}`}>
            {message.role === 'assistant' && (
              <>
                <div className={`bubble assistant ${hasThinkContent(message.content) ? 'has-think' : ''}`}>
                  {renderMessageContent({ role: 'assistant', content: message.content, showCursor: streaming && index === messages.length - 1 })}
                  {message.ts && <div className="msg-time">{formatMsgTime(message.ts)}</div>}
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
        ))}
        <div ref={bottomRef} />
        <div className="input-area">
          <div className="input-card">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={event => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={disabled}
            />
            <div className="input-toolbar">
              {memoryToggle}
              {sendButton}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
