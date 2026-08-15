import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../../i18n/I18nProvider.jsx';

// 已挂载的弹框栈。Escape 监听挂在 window 上，嵌套弹框（如设置里再开模型选择器）
// 会让每一层都收到同一次按键，一下关掉整摞；这里只让最上层响应。
const dialogStack = [];

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

    const token = {};
    dialogStack.push(token);

    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (closeDisabledRef.current || escapeDisabledRef.current) return;
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  const closeFromMask = () => {
    if (!closeDisabled) onClose?.();
  };

  // 经 portal 挂到 body：遮罩靠 position: fixed 铺满视口，而 fixed 会被任何带
  // transform / filter / backdrop-filter 的祖先降级为相对该祖先定位。输入框
  // (.agent-composer--dock) 就带 backdrop-filter，弹层留在原地会被压缩进输入框。
  return createPortal((
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
  ), document.body);
}
