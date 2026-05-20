import { useEffect } from 'react';

// Cmd/Ctrl+Shift+E 切换 Agent 面板折叠状态；Cmd/Ctrl+Shift+M 切换记忆面板。
export function useKeyboardShortcuts({ mode, setAgentCollapsed, setShowMemoryPanel, setShowSessions, showMemoryPanel }) {
  useEffect(() => {
    const handler = e => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey) return;
      if (e.key === 'E' || e.key === 'e') {
        e.preventDefault();
        if (mode === 'agent') setAgentCollapsed(c => !c);
      }
      if (e.key === 'M' || e.key === 'm') {
        e.preventDefault();
        setShowMemoryPanel(v => !v);
        if (!showMemoryPanel) setShowSessions(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, setAgentCollapsed, setShowMemoryPanel, setShowSessions, showMemoryPanel]);
}
