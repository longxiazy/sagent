import { Send, Square } from 'lucide-react';

// 发送/停止三态按钮：streaming → 停止 chat；agentRunning → 停止 agent；idle → 发送
export function SendButton({
  streaming,
  agentRunning,
  agentStopping,
  pendingApproval,
  inputValue,
  onSend,
  onStopGeneration,
  onStopAgent,
}) {
  if (streaming) {
    return (
      <button className="send-btn stop" onClick={onStopGeneration}>
        <Square size={12} /> 停止
      </button>
    );
  }
  if (agentRunning) {
    return (
      <button className="send-btn stop" onClick={onStopAgent} disabled={agentStopping}>
        <Square size={12} /> {agentStopping ? '正在停止…' : pendingApproval ? '停止并拒绝' : '停止'}
      </button>
    );
  }
  return (
    <button className="send-btn idle" onClick={onSend} disabled={!inputValue.trim()}>
      <Send size={14} /> 发送
    </button>
  );
}
