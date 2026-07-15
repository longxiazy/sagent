import { useEffect, useState } from 'react';

export function useResponsiveLayout({ dockedBreakpoint, sidebarPinned = false }) {
  const [showSessions, setShowSessions] = useState(() => window.innerWidth >= dockedBreakpoint && sidebarPinned);

  useEffect(() => {
    const syncResponsiveState = () => {
      if (window.innerWidth < dockedBreakpoint) {
        setShowSessions(false);
      }
    };

    window.addEventListener('resize', syncResponsiveState);
    return () => window.removeEventListener('resize', syncResponsiveState);
  }, [dockedBreakpoint]);

  return { showSessions, setShowSessions };
}
