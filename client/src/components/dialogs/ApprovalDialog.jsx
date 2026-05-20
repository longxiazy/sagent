export function ApprovalDialog({ approval, submitting, onApprove, onReject }) {
  if (!approval) {
    return null;
  }

  return (
    <div className="dialog-mask">
      <div className="dialog approval-dialog">
        <p className="approval-eyebrow">需要确认</p>
        <p className="dialog-title">Step {approval.step} 请求执行敏感操作</p>
        <p className="dialog-desc">{approval.message}</p>
        <pre className="agent-json approval-json">{JSON.stringify(approval.action, null, 2)}</pre>
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onReject} disabled={submitting}>
            拒绝
          </button>
          <button className="dialog-btn confirm approval-confirm" onClick={onApprove} disabled={submitting}>
            {submitting ? '提交中…' : '批准'}
          </button>
        </div>
      </div>
    </div>
  );
}
