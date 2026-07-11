const STORAGE_KEY = 'sagent_api_token';
let promptPromise = null;
let promptAttempted = false;

export function getApiToken() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setApiToken(token) {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(STORAGE_KEY, token);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 隐私模式或禁用 storage 时，当前请求仍可使用输入的 token。
  }
}

export async function promptForApiToken() {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return '';
  if (!promptPromise && promptAttempted) return '';
  if (!promptPromise) {
    promptAttempted = true;
    promptPromise = Promise.resolve().then(() => {
      const token = window.prompt('Sagent API 需要认证，请输入 SAGENT_API_TOKEN：', getApiToken());
      const normalized = String(token || '').trim();
      if (normalized) setApiToken(normalized);
      return normalized;
    }).finally(() => {
      promptPromise = null;
    });
  }
  return promptPromise;
}
