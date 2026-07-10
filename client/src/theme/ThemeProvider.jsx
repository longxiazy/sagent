/* eslint-disable react-refresh/only-export-components -- Provider 与 useTheme 同文件是常见模式；该规则仅影响开发期热更新 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePersistentState } from '../hooks/usePersistentState.js';

// 主题三态：light / dark / system。
// - light/dark：用户显式选择，固定不变。
// - system：跟随操作系统 prefers-color-scheme，并实时响应系统切换。
// resolvedTheme 是 system 折算后的最终值（只会是 light 或 dark），
// CSS 用 <html data-theme="light|dark"> 选择器消费它。
const THEME_KEY = 'app_theme';
const FONT_SIZE_KEY = 'app_font_size';

const ThemeContext = createContext(null);

const matchDark = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function resolveTheme(theme, systemDark) {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = usePersistentState(THEME_KEY, 'system');
  const [fontSize, setFontSize] = usePersistentState(FONT_SIZE_KEY, 'standard');
  const [systemDark, setSystemDark] = useState(() => matchDark()?.matches ?? false);

  // 监听系统主题变化：只有在 theme === 'system' 时才会影响 resolvedTheme，
  // 但 systemDark 一直跟踪，切回 system 时即时正确。
  useEffect(() => {
    const mql = matchDark();
    if (!mql) return undefined;
    const onChange = e => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = resolveTheme(theme, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset.fontSize = ['small', 'large'].includes(fontSize) ? fontSize : 'standard';
  }, [fontSize]);

  // 顶栏一键切换：在 light/dark 间翻转。若当前是 system，则相对当前呈现取反，
  // 切换后变成显式 light/dark（符合“点一下就立刻反过来”的直觉）。
  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo(
    () => ({ theme, setTheme, resolvedTheme, toggleTheme, fontSize, setFontSize }),
    [theme, setTheme, resolvedTheme, toggleTheme, fontSize, setFontSize]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
