// 桌面通知权限提示 banner：
// - default：未询问，给用户一个"开启"按钮
// - denied：被浏览器拦了，给出 chrome://settings 教学
// 调用方负责判断什么时候挂这个 banner（"agent 运行中且权限非 granted"）。
import { useT } from '../i18n/I18nProvider.jsx';

export function NotificationBanner({ perm, onEnable, onDismiss }) {
  const t = useT();
  return (
    <div className="notify-banner">
      {perm === 'default' ? (
        <>
          <span>{t('banner.default')}</span>
          <button className="notify-banner-btn" onClick={onEnable}>{t('banner.enable')}</button>
        </>
      ) : (
        <span>
          {t('banner.deniedPrefix')}
          {' '}
          <code>chrome://settings/content/siteDetails?site={window.location.origin}</code>
          {' '}
          {t('banner.deniedSuffix')}
        </span>
      )}
      <button className="notify-banner-close" onClick={onDismiss} title={t('banner.dismiss')}>×</button>
    </div>
  );
}
