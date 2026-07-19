// Agent 行为参数配置 + API Key 只读状态 API。
// GET 拉取当前配置/默认值/Key 状态；POST 保存参数；reset 恢复默认。
import { apiFetch } from './http.js';

export async function fetchConfig(projectId) {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const res = await apiFetch(`/api/config${q}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 保存 tools.model(vision/distill)。projectId 为空=全局,否则写该项目级 override。
export async function saveTools(tools, projectId) {
  const res = await apiFetch('/api/config/tools', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tools, projectId: projectId || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function saveConfig(patch) {
  const res = await apiFetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function resetConfig() {
  const res = await apiFetch('/api/config/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function applyConfigProfile(profile) {
  const res = await apiFetch('/api/config/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function saveMcpServer(name, server) {
  const res = await apiFetch(`/api/config/mcp/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(server),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function deleteMcpServer(name) {
  const res = await apiFetch(`/api/config/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function testMcpServer(name) {
  const res = await apiFetch(`/api/config/mcp/${encodeURIComponent(name)}/test`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
