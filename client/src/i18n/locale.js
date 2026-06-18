import { zh } from './locales/zh.js';
import { en } from './locales/en.js';

// 语言基础设施的「无 React」核心：
// 同时被 React 的 I18nProvider 和非 React 场景（类组件 ErrorBoundary、
// apiFetch 注入 Accept-Language、Service Worker 通知等）复用，避免在这些地方
// 依赖 hook。持久化 key 与 usePersistentState('app_lang') 一致。
export const LANG_KEY = 'app_lang';

export const SUPPORTED_LOCALES = ['zh', 'en'];

export const DICTS = { zh, en };

// 首次访问按浏览器语言判定：以 zh 开头→中文，其它→英文。
export function detectLocale() {
  try {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'zh';
    return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

// 直接读 localStorage 里用户已选语言；没有则回退到浏览器判定。
// 供 React 之外的代码（apiFetch / ErrorBoundary）取当前语言。
export function getLocale() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'zh' || stored === 'en') {
      return stored;
    }
  } catch {
    // localStorage 不可用（隐私模式等）时退回浏览器判定
  }
  return detectLocale();
}

// 扁平点分 key 查表 + {var} 插值。缺失的 key 回退为 key 本身，便于发现漏翻。
export function translate(locale, key, vars) {
  const dict = DICTS[locale] || DICTS.zh;
  let str = dict[key];
  if (str == null) {
    str = (DICTS.zh && DICTS.zh[key]) ?? key;
  }
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match));
  }
  return str;
}

// 非 React 场景下取译文（自带当前 locale）。
export function tStatic(key, vars) {
  return translate(getLocale(), key, vars);
}
