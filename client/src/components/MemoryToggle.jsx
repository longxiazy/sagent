import { Brain } from 'lucide-react';

// Agent 记忆开关。只在 agent 模式 + 未开始会话时显示。
export function MemoryToggle({ mode, sessionStarted, agentMemory, setAgentMemory }) {
  if (mode !== 'agent' || sessionStarted) return null;
  return (
    <button
      className={`toolbar-chip ${agentMemory ? 'active' : ''}`}
      onClick={() => setAgentMemory(v => !v)}
      title={agentMemory ? '使用历史记忆辅助任务' : '不使用记忆'}
    >
      <Brain size={12} /> {agentMemory ? '记忆开' : '记忆关'}
    </button>
  );
}
