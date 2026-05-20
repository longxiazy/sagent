export function ResetDialog({ onConfirm, onCancel }) {
  return (
    <div className="dialog-mask">
      <div className="dialog">
        <p className="dialog-title">清空当前会话内容？</p>
        <p className="dialog-desc">当前会话会保留，但消息记录会被移除。</p>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            取消
          </button>
          <button className="dialog-btn confirm" onClick={onConfirm}>
            清空
          </button>
        </div>
      </div>
    </div>
  );
}
