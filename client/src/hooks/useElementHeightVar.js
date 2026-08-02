import { useEffect } from 'react';

/**
 * 把元素的实时高度写进 CSS 自定义属性，供样式做布局补偿。
 *
 * 用途见 .agent-workspace-composer：输入框浮在消息流之上，消息区需要预留出
 * 等高的底部空间，否则最后一条会被永久遮住。而输入框高度是变的——textarea 随
 * 输入增长、工具栏在窄屏折成两行、附件栏出现时又高一截——写死数值必然失准，
 * 因此实测后交给 CSS。
 *
 * 写 CSS 变量而不是把数值传进 React state：高度变化频繁（每次敲键盘都可能触发），
 * 走 state 会引起整棵子树重渲染，而这里只需要样式跟着变。
 */
export function useElementHeightVar(ref, varName, { enabled = true } = {}) {
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;

    if (!enabled || !el || typeof ResizeObserver === 'undefined') {
      root.style.removeProperty(varName);
      return undefined;
    }

    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      root.style.setProperty(varName, `${Math.round(height)}px`);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      root.style.removeProperty(varName);
    };
  }, [enabled, ref, varName]);
}
