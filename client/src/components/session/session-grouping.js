import { calendarDaysAgo } from '../../utils/format.js';

// 按“最近活动时间”落入的分组（从新到旧）；match 接收 calendarDaysAgo 的自然日差。
// label 为 i18n key，渲染时经 t() 取译文。
export const GROUP_DEFS = [
  { key: 'today', label: 'sessionGroup.today', match: d => d === 0 },
  { key: 'yesterday', label: 'sessionGroup.yesterday', match: d => d === 1 },
  { key: 'week', label: 'sessionGroup.week', match: d => d >= 2 && d < 7 },
  { key: 'month', label: 'sessionGroup.month', match: d => d >= 7 && d < 30 },
  { key: 'earlier', label: 'sessionGroup.earlier', match: d => d >= 30 },
];

// 会话的最近活动时间：优先取最后一条带时间戳的消息（用户消息均带 ts，
// 不会被 App.jsx 的 trace 重建逻辑污染），回退到 updatedAt / createdAt。
export function lastActivityTs(session) {
  const msgs = session.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(msgs[i].ts)) return msgs[i].ts;
  }
  return session.updatedAt || session.createdAt || null;
}

// 按消息内容做大小写不敏感匹配（标题取自首条用户消息，已包含在消息内容中）。
// query 需为已 trim + lowercase 的非空串。
export function sessionMatchesQuery(session, query) {
  return (session.messages || []).some(
    msg => typeof msg.content === 'string' && msg.content.toLowerCase().includes(query)
  );
}

// 过滤 + 按最近活动时间分组，组内按时间倒序，空组剔除。
export function buildGroups(sessions, query) {
  const q = query.trim().toLowerCase();
  const matched = q ? sessions.filter(session => sessionMatchesQuery(session, q)) : sessions;
  const sorted = [...matched].sort((a, b) => (lastActivityTs(b) || 0) - (lastActivityTs(a) || 0));

  return GROUP_DEFS
    .map(def => ({
      key: def.key,
      label: def.label,
      sessions: sorted.filter(session => def.match(calendarDaysAgo(lastActivityTs(session) || Date.now()))),
    }))
    .filter(group => group.sessions.length > 0);
}
