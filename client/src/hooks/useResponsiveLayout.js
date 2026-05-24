import { useEffect, useState } from 'react';

export function useResponsiveLayout({ dockedBreakpoint, panelSizeKey }) {
  const [showSessions, setShowSessions] = useState(() => window.innerWidth >= dockedBreakpoint);

  useEffect(() => {
    const restorePanelWidth = () => {
      const panel = document.querySelector('.layout-body > .agent-panel-wrap');
      if (!panel) {
        return;
      }

      if (window.innerWidth >= dockedBreakpoint) {
        const saved = localStorage.getItem(panelSizeKey);
        panel.style.flex = saved ? `0 0 ${saved}px` : '';
        return;
      }

      panel.style.flex = '';
    };

    const syncResponsiveState = () => {
      restorePanelWidth();
      if (window.innerWidth < dockedBreakpoint) {
        setShowSessions(false);
      }
    };

    restorePanelWidth();
    window.addEventListener('resize', syncResponsiveState);
    return () => window.removeEventListener('resize', syncResponsiveState);
  }, [dockedBreakpoint, panelSizeKey]);

  return { showSessions, setShowSessions };
}
