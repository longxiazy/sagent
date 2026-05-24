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
  if (!notificationsSupported()) {
    console.warn('[Notifications] 当前浏览器不支持 Notification 或 ServiceWorker');
    return null;
  }
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js')
      .then(async reg => {
        await navigator.serviceWorker.ready;
        console.info('[Notifications] ServiceWorker 已注册', reg.scope);
        return reg;
      })
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

// 弹一条通知。kind: 'approval' | 'question' | 'success' | 'failure'。
// approval 带「允许/拒绝」按钮；question 只提醒（输入框在通知里没法填）；
// success/failure 是任务结束摘要，不需要交互。
export async function showAgentNotification({ runId, approvalId, message, kind = 'approval' }) {
  if (!notificationsSupported()) {
    console.warn('[Notifications] showAgentNotification 跳过：浏览器不支持');
    return false;
  }
  if (Notification.permission !== 'granted') {
    console.warn(`[Notifications] showAgentNotification 跳过：权限是 ${Notification.permission}（需要先点页面上的"开启桌面通知"）`);
    return false;
  }
  // approval/question 需要用户决策，必须带 approvalId；success/failure 只需要 runId。
  if (kind === 'approval' || kind === 'question') {
    if (!runId || !approvalId) {
      console.warn('[Notifications] showAgentNotification 跳过：缺 runId/approvalId', { runId, approvalId });
      return false;
    }
  } else if (!runId) {
    console.warn('[Notifications] showAgentNotification 跳过：缺 runId', { runId });
    return false;
  }

  const reg = await ensureServiceWorker();
  if (!reg) {
    console.warn('[Notifications] showAgentNotification 跳过：ServiceWorker 未就绪');
    return false;
  }

  let title;
  let actions = [];
  let requireInteraction = false;
  switch (kind) {
    case 'question':
      title = 'Desktop Agent 提问';
      requireInteraction = true;
      break;
    case 'success':
      title = 'Desktop Agent 已完成';
      break;
    case 'failure':
      title = 'Desktop Agent 失败';
      break;
    case 'approval':
    default:
      title = 'Desktop Agent 需要审批';
      actions = [
        { action: 'approve', title: '允许' },
        { action: 'reject', title: '拒绝' },
      ];
      requireInteraction = true;
      break;
  }

  const tag = approvalId
    ? `agent-${kind}-${approvalId}`
    : `agent-${kind}-${runId}`;

  try {
    await reg.showNotification(title, {
      body: truncate(message, 200),
      tag,
      renotify: true,
      requireInteraction,
      actions,
      data: { runId, approvalId, kind },
    });
    console.info('[Notifications] 已弹出通知', { kind, approvalId: approvalId || null, runId });
    return true;
  } catch (err) {
    console.warn('[Notifications] showNotification 失败', err);
    return false;
  }
}
