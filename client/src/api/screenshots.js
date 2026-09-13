// http-fetch / 浏览器 / 桌面观察截图资源管理 API。截图是全局资源,不带 projectId。
import { apiFetch } from './http.js';

export async function listScreenshots({ offset = 0, signal } = {}) {
  const query = new URLSearchParams({ offset: String(offset), limit: '10' });
  const res = await apiFetch(`/api/agent/screenshots?${query}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteScreenshot(runId, file) {
  const res = await apiFetch(
    `/api/agent/screenshots/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`,
    { method: 'DELETE' },
  );
  return res.json().catch(() => ({}));
}

export async function deleteScreenshotRun(runId) {
  const res = await apiFetch(`/api/agent/screenshots/${encodeURIComponent(runId)}`, { method: 'DELETE' });
  return res.json().catch(() => ({}));
}

export async function clearScreenshots() {
  const res = await apiFetch('/api/agent/screenshots', { method: 'DELETE' });
  return res.json().catch(() => ({}));
}

export async function runScreenshotCleanup({ signal } = {}) {
  const res = await apiFetch('/api/agent/screenshots/cleanup', { method: 'POST', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
