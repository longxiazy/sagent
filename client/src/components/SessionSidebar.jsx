import { useT } from '../i18n/I18nProvider.jsx';

export function SessionSidebar({ open, pinned = false, onClose, children }) {
  const t = useT();
  return (
    <>
      <div
        className={`sidebar ${open ? 'open' : ''} ${pinned ? 'pinned' : 'floating'}`}
        onMouseLeave={() => {
          if (!pinned && window.innerWidth >= 1100) onClose();
        }}
      >
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
