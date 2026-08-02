import { useId } from 'react';

/**
 * 工具栏里的开关胶囊：图标 + 文字 + iOS 风格滑块。
 *
 * 用 checkbox 而非 button 承载状态：这是「开/关」而非「按一下」，
 * 原生 checkbox 自带 role 与键盘行为，读屏也会念出勾选状态。
 * 视觉滑块由 CSS 绘制，真实 input 视觉隐藏但仍可聚焦，保留键盘可达性。
 */
export function ToolbarSwitch({ icon = null, label, checked, onChange, disabled = false, title }) {
  const inputId = useId();

  return (
    <label
      className={`toolbar-chip toolbar-switch${checked ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      htmlFor={inputId}
      title={title}
    >
      {icon}
      <span className="toolbar-switch-label">{label}</span>
      <input
        id={inputId}
        type="checkbox"
        className="toolbar-switch-input"
        checked={checked}
        onChange={event => onChange?.(event.target.checked)}
        disabled={disabled}
        // 窄屏下 label 文字被 CSS 隐藏，display:none 的内容不会被读屏朗读，
        // 届时 checkbox 将失去可访问名称。这里固定挂一份，与视觉无关。
        aria-label={label}
      />
      <span className="toolbar-switch-track" aria-hidden="true">
        <span className="toolbar-switch-thumb" />
      </span>
    </label>
  );
}
