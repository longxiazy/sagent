import { useState } from 'react';
import { submitAgentQuestion } from '../api/streams.js';

// QuestionDialog 的 submit / skip 回调封装：
// - submit：调后端记录回答，关闭弹窗，resolve 挂起的 Promise
// - skip：直接关闭弹窗 + resolve('')，不调后端
// 拆出来纯粹是因为内联在 props 里太长，影响 App.jsx 可读性。
export function useQuestionSubmit({ pendingQuestion, setPendingQuestion, questionRequestRef }) {
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async response => {
    if (!pendingQuestion) return;
    setSubmitting(true);
    try {
      await submitAgentQuestion({
        runId: pendingQuestion.runId,
        approvalId: pendingQuestion.approvalId,
        response,
      });
      setPendingQuestion(null);
      questionRequestRef.current?.resolve?.(response);
    } catch (err) {
      console.error('Question submit failed:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    setPendingQuestion(null);
    questionRequestRef.current?.resolve?.('');
  };

  return { submitting, handleSubmit, handleSkip };
}
