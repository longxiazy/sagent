export function AgentComposer({
  variant = 'dock',
  value,
  setValue,
  textareaRef,
  onKeyDown,
  placeholder,
  rows = 1,
  disabled = false,
  modelSelect = null,
  attachButton = null,
  privateModeToggle = null,
  sendButton = null,
  attachmentBar = null,
  contextMeter = null,
}) {
  const hasToolbar = Boolean(modelSelect || attachButton || privateModeToggle || contextMeter || sendButton);

  return (
    <div className={`agent-composer agent-composer--${variant}`}>
      {attachmentBar}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
      />
      {hasToolbar && (
        <div className="agent-composer-toolbar">
          {modelSelect}
          {attachButton}
          {privateModeToggle}
          {contextMeter && <div className="agent-composer-context">{contextMeter}</div>}
          {sendButton}
        </div>
      )}
    </div>
  );
}
