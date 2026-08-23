// 后端可用模型列表 API。
// 列表在后端启动时向各供应商拉取一次，之后按引用共享给路由与 agent runner；
// refresh 是唯一的运行期更新入口（全量重拉，任一供应商失败则整体放弃、列表不变）。
import { apiFetch } from './http.js';

export async function fetchModels() {
  const res = await apiFetch('/api/models');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function refreshModels() {
  const res = await apiFetch('/api/models/refresh', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
