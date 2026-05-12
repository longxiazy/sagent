// 浏览器审批通知工具：注册 ServiceWorker、请求权限、弹通知。
// 决策按钮的点击 → SW 直接 POST /api/agent/approvals（见 public/sw.js）。

let swRegistrationPromise = null;

export function notificationsSupported() {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator;
}

export function notificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function ensureServiceWorker() {
  if (!notificationsSupported()) return null;
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .catch(err => {
        console.warn('[Notifications] ServiceWorker 注册失败', err);
        swRegistrationPromise = null;
        return null;
      });
  }
  return swRegistrationPromise;
}

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function truncate(text, max = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// 弹一条通知。kind: 'approval' | 'question'。审批带「允许/拒绝」按钮，
// 问答仅作提醒（需要文本输入，通知里没法填）。
export async function showAgentNotification({ runId, approvalId, message, kind = 'approval' }) {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  if (!runId || !approvalId) return false;

  const reg = await ensureServiceWorker();
  if (!reg) return false;

  const isQuestion = kind === 'question';
  const title = isQuestion ? 'Desktop Agent 提问' : 'Desktop Agent 需要审批';
  const actions = isQuestion
    ? []
    : [
        { action: 'approve', title: '允许' },
        { action: 'reject', title: '拒绝' },
      ];

  try {
    await reg.showNotification(title, {
      body: truncate(message, 160),
      tag: `agent-${kind}-${approvalId}`,
      renotify: true,
      requireInteraction: true,
      actions,
      data: { runId, approvalId, kind },
    });
    return true;
  } catch (err) {
    console.warn('[Notifications] showNotification 失败', err);
    return false;
  }
}
