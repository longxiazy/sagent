import { useT } from '../i18n/I18nProvider.jsx';

export function SessionSidebar({ open, onClose, children }) {
  const t = useT();
  return (
    <>
      <div className={`sidebar ${open ? 'open' : ''}`}>
        {children}
      </div>
      <button
        className={`sidebar-backdrop ${open ? 'visible' : ''}`}
        onClick={onClose}
        aria-label={t('session.closeSidebar')}
      />
    </>
  );
}
