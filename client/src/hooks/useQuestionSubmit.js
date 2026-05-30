import { useState } from 'react';
import { submitAgentQuestion } from '../api/streams.js';

// QuestionDialog 的 submit / skip 回调封装：
// - submit：调后端记录回答，关闭弹窗,resolve 挂起的 Promise
// - skip：直接关闭弹窗 + resolve('')，不调后端
// clearQuestion(response) 由调用方提供:dispatch 清掉对应 run 的 pendingQuestion 并 resolve。
export function useQuestionSubmit({ pendingQuestion, clearQuestion }) {
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
      clearQuestion(response);
    } catch (err) {
      console.error('Question submit failed:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    clearQuestion('');
  };

  return { submitting, handleSubmit, handleSkip };
}
