import { useState } from 'react';

export function QuestionDialog({ question, submitting, onSubmit, onSkip }) {
  const [response, setResponse] = useState('');
  if (!question) return null;

  return (
    <div className="dialog-mask">
      <div className="dialog approval-dialog">
        <p className="approval-eyebrow">Agent 提问</p>
        <p className="dialog-title">Step {question.step} 需要你的回答</p>
        <p className="dialog-desc">{question.message}</p>
        <textarea
          className="system-textarea"
          value={response}
          onChange={e => setResponse(e.target.value)}
          placeholder="输入你的回答..."
          rows={3}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(response); } }}
          autoFocus
        />
        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onSkip} disabled={submitting}>
            跳过
          </button>
          <button
            className="dialog-btn confirm approval-confirm"
            onClick={() => onSubmit(response)}
            disabled={submitting}
          >
            {submitting ? '提交中…' : '回答'}
          </button>
        </div>
      </div>
    </div>
  );
}
