import { useEffect, useState } from 'react';

// 响应窗口宽度变化的移动端判定。替代散落各处的一次性 window.innerWidth 读取，
// 旋转屏幕/拖拽窗口时会同步更新。
export function useIsMobile(breakpoint) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < breakpoint,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);

  return isMobile;
}
