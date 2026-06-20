// 代码知识图谱(Code Graph)API：拉取/重新索引/搜索,均按当前项目 id 隔离。
import { apiFetch } from './http.js';

function withParams(path, projectId, extra = {}) {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// 返回 { graph, job }：graph 为 codegraph.json 内容(可能 null),job 为当前索引任务状态(可能 null)。
export async function fetchCodegraph(projectId) {
  const res = await apiFetch(withParams('/api/agent/codegraph', projectId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 触发后台重新索引,立即返回 { ok, job }。需指定用于生成语义的模型。
export async function reindexCodegraph(projectId, model) {
  const res = await apiFetch(withParams('/api/agent/codegraph/reindex', projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
