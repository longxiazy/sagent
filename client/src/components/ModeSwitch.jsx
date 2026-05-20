// 模式切换：chat / agent。只在 sessionStarted=false 时渲染。
export function ModeSwitch({ mode, setMode, sessionLocked, sessionStarted }) {
  if (sessionStarted) return null;
  return (
    <div className="mode-switch" aria-label="模式切换">
      <button
        className={`mode-btn ${mode === 'chat' ? 'active' : ''}`}
        onClick={() => setMode('chat')}
        disabled={sessionLocked}
      >对话</button>
      <button
        className={`mode-btn ${mode === 'agent' ? 'active' : ''}`}
        onClick={() => setMode('agent')}
        disabled={sessionLocked}
      >Agent</button>
    </div>
  );
}
