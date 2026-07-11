import { getLocale } from '../i18n/locale.js';
import { getApiToken, promptForApiToken } from './auth.js';

// 统一 fetch 封装：给所有 API 请求带上 X-Lang，让后端按用户在前台选择的语言
// 返回错误/状态/建议等面向用户的文案。
// 用自定义头 X-Lang 而非 Accept-Language——后者是 fetch 规范里的禁止改写头，
// 浏览器会忽略前端对它的设置；后端把 X-Lang 作为首选、Accept-Language 兜底。
function withApiHeaders(options, token) {
  const headers = new Headers(options.headers || {});
  if (!headers.has('X-Lang')) {
    headers.set('X-Lang', getLocale());
  }
  if (token && !headers.has('Authorization') && !headers.has('X-Sagent-Token')) {
    headers.set('X-Sagent-Token', token);
  }
  return { ...options, headers };
}

export async function apiFetch(url, options = {}) {
  const initialToken = getApiToken();
  const response = await fetch(url, withApiHeaders(options, initialToken));
  if (response.status !== 401) return response;

  const storedToken = getApiToken();
  const token = storedToken && storedToken !== initialToken
    ? storedToken
    : await promptForApiToken();
  if (!token) return response;
  await response.body?.cancel().catch(() => {});
  return fetch(url, withApiHeaders(options, token));
}
