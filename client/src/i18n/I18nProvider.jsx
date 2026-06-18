/* eslint-disable react-refresh/only-export-components -- Provider 与 useI18n/useT 同文件是常见模式；该规则仅影响开发期热更新 */
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { usePersistentState } from '../hooks/usePersistentState.js';
import { LANG_KEY, detectLocale, translate } from './locale.js';

// 轻量 i18n：locale ∈ zh|en，持久化于 localStorage('app_lang')，
// 首次按 navigator.language 判定。useT() 返回 t(key, vars?)。
const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocale] = usePersistentState(LANG_KEY, detectLocale);

  // 同步 <html lang>，利于无障碍/搜索/部分浏览器内置翻译判断。
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return ctx;
}

// 便捷 hook：组件里只需要翻译函数时用它。
export function useT() {
  return useI18n().t;
}
