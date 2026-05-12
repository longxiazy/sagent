/* sagent ServiceWorker — 处理审批通知的按钮点击与窗口聚焦。
   注册作用域是根路径 /，配合 Vite 代理 /api 到后端。
*/

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

async function focusOrOpenWindow() {
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sameOrigin = allClients.find(client => client.url.startsWith(self.location.origin));
  if (sameOrigin) {
    try {
      await sameOrigin.focus();
      return;
    } catch {
      // focus 可能被浏览器拒绝（如 Safari），fallback 到 openWindow
    }
  }
  try {
    await self.clients.openWindow('/');
  } catch {
    // 没有权限打开新窗口时，无能为力
  }
}

async function postApprovalDecision(data, decision) {
  const { runId, approvalId } = data || {};
  if (!runId || !approvalId) return;
  try {
    await fetch('/api/agent/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, approvalId, decision }),
    });
  } catch {
    // 网络错误不阻塞窗口聚焦
  }
}

self.addEventListener('notificationclick', event => {
  const { action, notification } = event;
  const data = notification.data || {};
  notification.close();

  event.waitUntil((async () => {
    if (action === 'approve' || action === 'reject') {
      await postApprovalDecision(data, action);
    }
    await focusOrOpenWindow();
  })());
});
