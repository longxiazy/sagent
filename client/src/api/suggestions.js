// 主页"试试这些任务/问题"建议数据 API。
// GET 拉取 agent 分类数据。
import { apiFetch } from './http.js';

export async function fetchSuggestions() {
  const res = await apiFetch('/api/suggestions');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
