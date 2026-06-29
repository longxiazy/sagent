import { Send, Square } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

// 发送/停止按钮：Agent 运行中停止，空闲时发送。
export function SendButton({
  agentRunning,
  agentStopping,
  pendingApproval,
  inputValue,
  blockReason,
  contextEstimate,
  onSend,
  onStopAgent,
}) {
  const t = useT();
  const contextPercent = Math.max(0, Math.min(100, contextEstimate?.percent || 0));
  const contextRisk = contextEstimate?.risk || 'ok';
  if (agentRunning) {
    return (
      <button className="send-btn stop" onClick={onStopAgent} disabled={agentStopping}>
        <Square size={12} /> {agentStopping ? t('send.stopping') : pendingApproval ? t('send.stopReject') : t('send.stop')}
      </button>
    );
  }
  // blockReason 非空时(例如 agent 模式一个模型都没选)禁用并把原因作为 tooltip。
  return (
    <button
      className={`send-btn idle context-${contextRisk}`}
      onClick={onSend}
      disabled={!inputValue.trim() || !!blockReason}
      title={blockReason || undefined}
      style={{ '--send-context-progress': `${contextPercent}%` }}
    >
      <span className="send-progress-ring" aria-hidden="true">
        <Send size={13} />
      </span>
      {t('send.send')}
    </button>
  );
}
