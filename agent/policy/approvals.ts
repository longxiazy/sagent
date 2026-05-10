import { spawn, execSync } from 'node:child_process';
import { classifyAgentAction } from './classify.ts';
import { cleanText } from '../core/utils.ts';
import { log } from '../../helpers/logger.ts';

const HOST = `http://127.0.0.1:${process.env.PORT || 3001}`;

function showApprovalDialog(runId: string, approvalId: string, message: string) {
  const safeMsg = message.replace(/\n/g, ' ').slice(0, 200);

  if (process.platform === 'win32') {
    const escapedMsg = safeMsg.replace(/'/g, "''");
    const script = `
      try {
        Add-Type -AssemblyName System.Windows.Forms
        $result = [System.Windows.Forms.MessageBox]::Show(
          '${escapedMsg}',
          'Agent 审批请求',
          'YesNo',
          'Question'
        )
        Write-Output $result
      } catch {
        Write-Error $_.Exception.Message
        exit 2
      }
    `;
    const child = spawn('pwsh', ['-NoProfile', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code: number) => {
      if (code === 2) {
        log.warn(`[ApprovalDialog] Windows 弹窗失败: ${stderr.trim()}，等待 Web UI 处理`);
        return;
      }
      const decision = stdout.trim() === 'Yes' ? 'approve' : 'reject';
      log.info(`[ApprovalDialog] 用户${decision === 'approve' ? '批准' : '拒绝'} runId=${runId}`);
      const body = JSON.stringify({ runId, approvalId, decision });
      spawn('pwsh', ['-NoProfile', '-Command', `Invoke-RestMethod -Uri '${HOST}/api/agent/approvals' -Method Post -ContentType 'application/json' -Body '${body}'`], { stdio: 'ignore' });
    });
    return;
  }

  if (process.platform !== 'darwin') return;
  const escapedMsg = safeMsg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    set dialogResult to display alert "Agent 审批请求" message "${escapedMsg}" as informational buttons {"拒绝", "批准"} default button "批准" cancel button "拒绝" giving up after 120
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
    const body = JSON.stringify({ runId, approvalId, decision });
    spawn('curl', ['-s', '-X', 'POST', `${HOST}/api/agent/approvals`, '-H', 'Content-Type: application/json', '-d', body], { stdio: 'ignore' });
  });
}

function showQuestionDialog(runId: string, approvalId: string, question: string) {
  const safeQ = question.replace(/\n/g, ' ').slice(0, 200);

  if (process.platform === 'win32') {
    const escapedQ = safeQ.replace(/'/g, "''");
    const script = `
      try {
        Add-Type -AssemblyName Microsoft.VisualBasic
        $result = [Microsoft.VisualBasic.Interaction]::InputBox(
          '${escapedQ}',
          'Agent 提问',
          ''
        )
        if ($result -eq '') { Write-Output '__skip__' } else { Write-Output $result }
      } catch {
        Write-Error $_.Exception.Message
        exit 2
      }
    `;
    const child = spawn('pwsh', ['-NoProfile', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code: number) => {
      if (code === 2) {
        log.warn(`[QuestionDialog] Windows 弹窗失败: ${stderr.trim()}，等待 Web UI 处理`);
        return;
      }
      const response = stdout.trim();
      const skipped = !response || response === '__skip__';
      log.info(`[QuestionDialog] 用户回答: ${skipped ? '(跳过)' : response} runId=${runId}`);
      const body = JSON.stringify({ runId, approvalId, response: skipped ? '' : response });
      spawn('pwsh', ['-NoProfile', '-Command', `Invoke-RestMethod -Uri '${HOST}/api/agent/question' -Method Post -ContentType 'application/json' -Body '${body}'`], { stdio: 'ignore' });
    });
    return;
  }

  if (process.platform !== 'darwin') return;
  const escapedQ = safeQ.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    set dialogResult to display dialog "${escapedQ}" default answer "" with title "Agent 提问" buttons {"跳过", "回答"} default button "回答" cancel button "跳过" giving up after 120
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
  if (process.platform === 'win32') {
    const safeTitle = title.replace(/'/g, "''");
    const safeBody = body.replace(/'/g, "''");
    spawn('pwsh', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Question; $n.BalloonTipTitle = '${safeTitle}'; $n.BalloonTipText = '${safeBody}'; $n.Visible = $true; $n.ShowBalloonTip(5000); Start-Sleep -Seconds 6; $n.Dispose()`,
    ], { stdio: 'ignore' });
    return;
  }
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