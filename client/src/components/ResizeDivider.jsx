import { useEffect, useRef } from 'react';
import {
  DOCKED_LAYOUT_BREAKPOINT,
  PANEL_MIN,
  PANEL_MAX_RATIO,
  PANEL_SIZE_KEY,
} from '../utils/constants.js';

// 桌面端 Agent 面板支持拖拽调整宽度，宽度直接写 localStorage，
// 这样刷新页面后仍然能保持用户上一次的布局偏好。
export function ResizeDivider() {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = e => {
    if (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT) return;
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    const panel = document.querySelector('.layout-body > .agent-panel-wrap');
    startWidth.current = panel ? panel.getBoundingClientRect().width : 420;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMouseMove = e => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const maxW = Math.round(window.innerWidth * PANEL_MAX_RATIO);
      const next = Math.min(Math.max(startWidth.current + delta, PANEL_MIN), maxW);
      localStorage.setItem(PANEL_SIZE_KEY, String(next));
      const panel = document.querySelector('.layout-body > .agent-panel-wrap');
      if (panel) panel.style.flex = `0 0 ${next}px`;
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return <div className="resize-divider" onMouseDown={onMouseDown} />;
}
