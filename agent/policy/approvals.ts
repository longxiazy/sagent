import { spawn, execSync } from 'node:child_process';
import { classifyAgentAction } from './classify.ts';
import { cleanText } from '../core/utils.ts';
import { log } from '../../helpers/logger.ts';

const HOST = `http://127.0.0.1:${process.env.PORT || 3001}`;

function showApprovalDialog(runId: string, approvalId: string, message: string) {
  if (process.platform !== 'darwin') return;
  const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 200);
  // 异步弹对话框，用户点击后回调 API
  const script = `
    set dialogResult to display alert "Agent 审批请求" message "${safeMsg}" as informational buttons {"拒绝", "批准"} default button "批准" cancel button "拒绝" giving up after 120
    if button returned of dialogResult is "批准" then
      return "approve"
    else
      return "reject"
    end if`;
  const child = spawn('osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.on('close', (code: number) => {
    const decision = code === 0 ? 'approve' : 'reject';
    log.info(`[ApprovalDialog] 用户${decision === 'approve' ? '批准' : '拒绝'} runId=${runId}`);
    // 调 API 解除审批阻塞
    const body = JSON.stringify({ runId, approvalId, decision });
    spawn('curl', ['-s', '-X', 'POST', `${HOST}/api/agent/approvals`, '-H', 'Content-Type: application/json', '-d', body], { stdio: 'ignore' });
  });
}

function showQuestionDialog(runId: string, approvalId: string, question: string) {
  if (process.platform !== 'darwin') return;
  const safeQ = question.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 200);
  const script = `
    set dialogResult to display dialog "${safeQ}" default answer "" with title "Agent 提问" buttons {"跳过", "回答"} default button "回答" cancel button "跳过" giving up after 120
    set userResponse to text returned of dialogResult
    if userResponse is "" then return "__skip__"
    return userResponse`;
  const child = spawn('osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.on('close', (code: number) => {
    const response = code === 0 ? stdout.trim() : '';
    log.info(`[QuestionDialog] 用户回答: ${response || '(跳过)'} runId=${runId}`);
    const body = JSON.stringify({ runId, approvalId, response: response === '__skip__' ? '' : response });
    spawn('curl', ['-s', '-X', 'POST', `${HOST}/api/agent/question`, '-H', 'Content-Type: application/json', '-d', body], { stdio: 'ignore' });
  });
}

function sendMacosNotification(title: string, body: string) {
  if (process.platform !== 'darwin') return;
  const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "Glass"`;
  try {
    spawn('osascript', ['-e', script], { stdio: 'ignore' });
  } catch (err: any) {
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

    if (isQuestion) {
      sendMacosNotification('Desktop Agent 提问', `${cleanText(action.question, 120)}`);
      showQuestionDialog(runId, approvalId, cleanText(action.question, 200));
    } else {
      sendMacosNotification('Desktop Agent 需要审批', `${cleanText(policy.reason, 120)}`);
      showApprovalDialog(runId, approvalId, cleanText(policy.reason, 200));
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