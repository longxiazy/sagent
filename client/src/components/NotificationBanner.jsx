// 桌面通知权限提示 banner：
// - default：未询问，给用户一个"开启"按钮
// - denied：被浏览器拦了，给出 chrome://settings 教学
// 调用方负责判断什么时候挂这个 banner（"agent 运行中且权限非 granted"）。
export function NotificationBanner({ perm, onEnable, onDismiss }) {
  return (
    <div className="notify-banner">
      {perm === 'default' ? (
        <>
          <span>桌面通知未开启，开启后 Agent 等待审批时会在桌面提醒你。</span>
          <button className="notify-banner-btn" onClick={onEnable}>开启桌面通知</button>
        </>
      ) : (
        <span>
          桌面通知被浏览器阻止了。打开
          {' '}
          <code>chrome://settings/content/siteDetails?site={window.location.origin}</code>
          {' '}
          把「通知」改为「允许」，然后刷新页面。
        </span>
      )}
      <button className="notify-banner-close" onClick={onDismiss} title="先不开">×</button>
    </div>
  );
}
