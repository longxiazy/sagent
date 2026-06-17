// Agent 行为参数配置 + API Key 只读状态 API。
// GET 拉取当前配置/默认值/Key 状态；POST 保存参数；reset 恢复默认。

export async function fetchConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveConfig(patch) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function resetConfig() {
  const res = await fetch('/api/config/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
