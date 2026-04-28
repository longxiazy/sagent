import { spawn } from 'node:child_process';
import { classifyAgentAction } from './classify.js';
import { cleanText } from '../core/utils.js';
import { log } from '../../helpers/logger.js';

function sendMacosNotification(title, body) {
  if (process.platform !== 'darwin') {
    log.warn(`[Notification] macOS 通知不可用，当前平台: ${process.platform}`);
    return;
  }
  const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "Glass"`;
  try {
    spawn('osascript', ['-e', script], { stdio: 'ignore' });
  } catch (err) {
    log.warn(`[Notification] osascript 调用失败: ${err.message}`);
  }
}

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
      throw new Error(policy.reason);
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

    if (isQuestion) {
      sendMacosNotification(
        'Desktop Agent 提问',
        `${cleanText(action.question, 120)}`
      );
    } else {
      sendMacosNotification(
        'Desktop Agent 需要审批',
        `${cleanText(policy.reason, 120)}\n\nrunId: ${runId}`
      );
    }

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