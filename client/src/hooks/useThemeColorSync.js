import { useEffect } from 'react';
import {
  PHONE_BREAKPOINT,
  DOCKED_LAYOUT_BREAKPOINT,
  APP_BG_COLOR,
  APP_SURFACE_COLOR,
  APP_BG_COLOR_DARK,
  APP_SURFACE_COLOR_DARK,
} from '../utils/constants.js';

// 在移动端/窄屏时，会话侧栏和 Agent 面板会改变页面主色块区域。
// 同步 <meta name="theme-color"> 是为了让浏览器地址栏颜色也跟着切换。
// resolvedTheme 决定取亮色还是暗色那一组背景/表面色。
export function useThemeColorSync({ mode, agentMobileTab, showSessions, resolvedTheme }) {
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const isDark = resolvedTheme === 'dark';
    const bgColor = isDark ? APP_BG_COLOR_DARK : APP_BG_COLOR;
    const surfaceColor = isDark ? APP_SURFACE_COLOR_DARK : APP_SURFACE_COLOR;

    const isPhoneViewport = window.innerWidth <= PHONE_BREAKPOINT;
    const showSurfaceChrome = (isPhoneViewport && mode === 'agent' && agentMobileTab === 'agent')
      || (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT && showSessions);

    meta.setAttribute('content', showSurfaceChrome ? surfaceColor : bgColor);
  }, [mode, agentMobileTab, showSessions, resolvedTheme]);
}
