// 主页"试试这些任务/问题"建议数据 API。
// GET 拉取 chat + agent 分类数据;POST fire-and-forget 累计使用记录。

export async function fetchSuggestions() {
  const res = await fetch('/api/suggestions');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function recordSuggestionUse({ title, text }) {
  return fetch('/api/suggestions/use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, text }),
  }).catch(() => {});
}
