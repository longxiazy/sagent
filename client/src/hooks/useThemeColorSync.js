import { useEffect } from 'react';
import {
  PHONE_BREAKPOINT,
  DOCKED_LAYOUT_BREAKPOINT,
  APP_BG_COLOR,
  APP_SURFACE_COLOR,
} from '../utils/constants.js';

// 在移动端/窄屏时，会话侧栏和 Agent 面板会改变页面主色块区域。
// 同步 <meta name="theme-color"> 是为了让浏览器地址栏颜色也跟着切换。
export function useThemeColorSync({ mode, agentMobileTab, showSessions }) {
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;

    const isPhoneViewport = window.innerWidth <= PHONE_BREAKPOINT;
    const showSurfaceChrome = (isPhoneViewport && mode === 'agent' && agentMobileTab === 'agent')
      || (window.innerWidth < DOCKED_LAYOUT_BREAKPOINT && showSessions);

    meta.setAttribute('content', showSurfaceChrome ? APP_SURFACE_COLOR : APP_BG_COLOR);
  }, [mode, agentMobileTab, showSessions]);
}
