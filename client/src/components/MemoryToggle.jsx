import { Brain } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

// Agent 记忆开关。只在 agent 模式 + 未开始会话时显示。
export function MemoryToggle({ mode, sessionStarted, agentMemory, setAgentMemory }) {
  const t = useT();
  if (mode !== 'agent' || sessionStarted) return null;
  return (
    <button
      className={`toolbar-chip ${agentMemory ? 'active' : ''}`}
      onClick={() => setAgentMemory(v => !v)}
      title={agentMemory ? t('memoryToggle.onTitle') : t('memoryToggle.offTitle')}
    >
      <Brain size={12} /> {agentMemory ? t('memoryToggle.on') : t('memoryToggle.off')}
    </button>
  );
}
