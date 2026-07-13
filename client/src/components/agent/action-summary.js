// 把一个 action 浓缩成一行可读摘要：`tool.type 关键参数`。
// 供 StepCard 头部与 ModelPlanCard 折叠态复用，保证两处口径一致，
// 避免默认就把整段 JSON.stringify 撑在面板里。

const MAX_PARAM_LEN = 40;

// 按优先级挑一个最能说明动作意图的参数来展示（命令/路径/URL 优先于纯 id）。
const PARAM_PRIORITY = ['command', 'path', 'url', 'text', 'query', 'selector', 'question', 'app', 'key', 'id'];

function clip(value) {
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > MAX_PARAM_LEN ? `${s.slice(0, MAX_PARAM_LEN)}…` : s;
}

// 返回 `tool.type`，tool 缺省视为 core。
export function actionTitle(action) {
  if (!action || typeof action !== 'object') return '';
  return `${action.tool || 'core'}.${action.type || '?'}`;
}

// 返回 `tool.type 关键参数` 的一行摘要。
export function summarizeAction(action) {
  if (!action || typeof action !== 'object') return '';
  const head = actionTitle(action);

  // 坐标类动作单独处理（兼容历史 trace）。
  if (action.x != null && action.y != null) return `${head} (${action.x}, ${action.y})`;

  for (const key of PARAM_PRIORITY) {
    const v = action[key];
    if (v == null || v === '') continue;
    return key === 'id' ? `${head} #${clip(v)}` : `${head} ${clip(v)}`;
  }
  return head;
}
