import { Send, Square } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

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
  const t = useT();
  if (streaming) {
    return (
      <button className="send-btn stop" onClick={onStopGeneration}>
        <Square size={12} /> {t('send.stop')}
      </button>
    );
  }
  if (agentRunning) {
    return (
      <button className="send-btn stop" onClick={onStopAgent} disabled={agentStopping}>
        <Square size={12} /> {agentStopping ? t('send.stopping') : pendingApproval ? t('send.stopReject') : t('send.stop')}
      </button>
    );
  }
  return (
    <button className="send-btn idle" onClick={onSend} disabled={!inputValue.trim()}>
      <Send size={14} /> {t('send.send')}
    </button>
  );
}
