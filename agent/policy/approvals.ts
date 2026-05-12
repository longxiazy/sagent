import { classifyAgentAction } from './classify.ts';

export function createAgentAuthorizer({
  runId,
  approvalStore,
  onEvent,
}) {
  return async (_state, action, context) => {
    const policy = classifyAgentAction(action);

    if (policy.level === 'safe') {
      return {
        status: 'approved',
      };
    }

    if (policy.level === 'blocked') {
      onEvent?.({
        type: 'approval_result',
        runId,
        step: context.step,
        decision: 'blocked',
        action,
        message: policy.reason,
      });
      return {
        status: 'rejected',
        message: policy.reason,
      };
    }

    const { approvalId, promise } = approvalStore.request({
      step: context.step,
      action,
    });

    const isQuestion = action.type === 'ask_user';
    const eventType = isQuestion ? 'question_required' : 'approval_required';

    onEvent?.({
      type: eventType,
      runId,
      approvalId,
      step: context.step,
      action,
      message: isQuestion ? action.question : policy.reason,
    });

    const decision = await promise;

    if (isQuestion) {
      const response = typeof decision === 'string' && decision !== 'approve' && decision !== 'reject'
        ? decision : '';
      onEvent?.({
        type: 'user_response',
        runId,
        approvalId,
        step: context.step,
        question: action.question,
        response,
      });
      if (!response) {
        return { status: 'rejected', message: '用户跳过了问题', response: '' };
      }
      return { status: 'approved', response };
    }

    const approved = decision === 'approve';

    onEvent?.({
      type: 'approval_result',
      runId,
      approvalId,
      step: context.step,
      decision: approved ? 'approve' : 'reject',
      action,
      message: approved ? '用户已批准操作' : '用户拒绝了操作',
    });

    if (!approved) {
      return {
        status: 'rejected',
        message: '用户拒绝批准该操作，Agent 将尝试其他方案。',
      };
    }

    return {
      status: 'approved',
    };
  };
}
