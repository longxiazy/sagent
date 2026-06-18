import { tStatic } from '../i18n/locale.js';

export function formatMsgTime(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(ts);
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

// 当天 0 点（本地时区）的时间戳。
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 距今天的自然日数（本地时区）：今天 = 0，昨天 = 1，依此类推。会话列表分组用。
export function calendarDaysAgo(ts) {
  return Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
}

// 完整时间 YYYY-MM-DD HH:mm（本地时区），用于卡片绝对时间与 hover title。
export function formatFullTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 短绝对时间 MM-DD HH:mm（本地时区），用于卡片上与相对时间并列展示。
export function formatShortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 相对时间：刚刚 / N分钟前 / N小时前 / 昨天 / N天前 / MM-DD / YYYY-MM-DD。
export function formatRelativeTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';

  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs < 0) {
    // 时钟漂移导致的“未来”时间，回退为完整日期。
    return formatFullTime(ts);
  }

  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return tStatic('time.justNow');
  if (diffMin < 60) return tStatic('time.minutesAgo', { n: diffMin });

  const dayDiff = calendarDaysAgo(ts);
  if (dayDiff === 0) return tStatic('time.hoursAgo', { n: Math.floor(diffMin / 60) });
  if (dayDiff === 1) return tStatic('time.yesterday');
  if (dayDiff < 7) return tStatic('time.daysAgo', { n: dayDiff });

  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
