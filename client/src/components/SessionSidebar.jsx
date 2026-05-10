export function SessionSidebar({ open, onClose, children }) {
  return (
    <>
      <div className={`sidebar ${open ? 'open' : ''}`}>
        {children}
      </div>
      <button
        className={`sidebar-backdrop ${open ? 'visible' : ''}`}
        onClick={onClose}
        aria-label="关闭会话列表"
      />
    </>
  );
}
