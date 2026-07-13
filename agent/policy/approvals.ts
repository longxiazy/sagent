import { classifyAgentAction } from './classify.ts';
import type {
  AgentAction,
  AgentAuthorization,
  AgentEventWriter,
  AgentExecutionContext,
  AgentRunStore,
  ApprovalStore,
} from '../core/contracts.ts';

export function createAgentAuthorizer({
  runId,
  approvalStore,
  onEvent,
  runStore,
}: {
  runId: string;
  approvalStore: Pick<ApprovalStore, 'request'>;
  onEvent?: AgentEventWriter;
  runStore?: AgentRunStore | null;
}) {
  return async (_state: unknown, action: AgentAction, context: AgentExecutionContext): Promise<AgentAuthorization> => {
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

    const isQuestion = action.type === 'ask_user';
    const eventType = isQuestion ? 'question_required' : 'approval_required';
    const message = isQuestion ? action.question : policy.reason;

    const { approvalId, promise } = approvalStore.request({
      type: eventType,
      runId,
      step: context.step,
      action,
      message,
    });

    onEvent?.({
      type: eventType,
      runId,
      approvalId,
      step: context.step,
      action,
      message,
    });

    if (runStore?.getRun(runId)?.status === 'running') {
      runStore.transitionRun(runId, 'waiting_approval');
    }
    let decision: string;
    try {
      decision = await promise;
    } finally {
      if (runStore?.getRun(runId)?.status === 'waiting_approval') {
        runStore.transitionRun(runId, 'running');
      }
    }

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
