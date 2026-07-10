import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';

export function DialogShell({
  title,
  subtitle,
  onClose,
  closeDisabled = false,
  escapeDisabled = false,
  headerActions = null,
  maskClassName = '',
  dialogClassName = '',
  children,
  footer = null,
}) {
  const t = useT();
  const titleId = useId();
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const escapeDisabledRef = useRef(escapeDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
    escapeDisabledRef.current = escapeDisabled;
  }, [closeDisabled, escapeDisabled, onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKeyDown = event => {
      if (event.key === 'Escape' && !closeDisabledRef.current && !escapeDisabledRef.current) onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  const closeFromMask = () => {
    if (!closeDisabled) onClose?.();
  };

  return (
    <div className={`model-picker-mask ${maskClassName}`.trim()} onPointerDown={closeFromMask}>
      <div
        className={`model-picker-dialog ${dialogClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="model-picker-header">
          <div className="model-picker-title">
            <span id={titleId}>{title}</span>
            {subtitle != null && <span className="model-picker-subtitle">{subtitle}</span>}
          </div>
          <div className="model-picker-header-actions">
            {headerActions}
            <button
              ref={closeRef}
              type="button"
              className="model-picker-close"
              onClick={onClose}
              disabled={closeDisabled}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
}
