/**
 * Approval Store — 管理跨请求的用户审批/提问状态
 *
 * 审批流程是跨 HTTP 请求的协调：
 *   1. Agent 运行中 (POST /api/agent) → request → 创建 Promise 阻塞 agent 循环
 *   2. 用户操作 (POST /api/agent/approvals) → resolve → 解除阻塞，agent 继续
 *
 * 调用场景：
 *   - agent/policy/approvals.ts 的 createAgentAuthorizer 中调用 request
 *   - agent/worker/runner.ts 的 worker 审批桥接中调用 request（沙箱模式）
 *   - routes/agent-approval.ts 的 POST /api/agent/approvals 调用 resolve（审批决定）
 *   - routes/agent-approval.ts 的 POST /api/agent/question 调用 resolve（回答提问）
 *   - routes/agent-run-control.ts / agent-run-session.ts / server.ts 的清理路径调用 rejectAll
 */

import type { ApprovalPayload, ApprovalStore } from './contracts.ts';

/** 生成唯一审批 ID：时间戳(36 进制) + 随机后缀 */
function createApprovalId() {
  return `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface ApprovalRecord {
  approvalId: string;
  payload: ApprovalPayload;
  resolve: (decision: string) => void;
}

export class ApprovalNotFoundError extends Error {
  readonly code = 'APPROVAL_NOT_FOUND';

  constructor(readonly approvalId: string) {
    super(`审批不存在: ${approvalId}`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalRunMismatchError extends Error {
  readonly code = 'APPROVAL_RUN_MISMATCH';

  constructor(
    readonly approvalId: string,
    readonly expectedRunId: string,
    readonly actualRunId: string,
  ) {
    super(`审批与运行不匹配: ${approvalId}`);
    this.name = 'ApprovalRunMismatchError';
  }
}

/** 把存储记录序列化为对外返回的审批对象（含 approvalId） */
function serializeApproval(approval: ApprovalRecord) {
  return {
    ...approval.payload,
    approvalId: approval.approvalId,
  };
}

export function createApprovalStore(): ApprovalStore {
  const pending = new Map<string, ApprovalRecord>();

  return {
    /**
     * 创建审批请求并返回阻塞 Promise
     *
     * 用法：policy 层检测到需审批的动作时调用，await promise 即暂停 agent 步骤，
     * 由路由层的 resolve 解除。
     * @param {Object} payload - 审批上下文（step, action 等）
     * @param {string} requestedApprovalId - worker bridge 已发给前端的审批 ID
     * @returns {{ approvalId: string, promise: Promise<string> }}
     */
    request(payload: ApprovalPayload, requestedApprovalId?: string) {
      const approvalId = requestedApprovalId || createApprovalId();
      if (pending.has(approvalId)) {
        throw new Error(`审批已存在: ${approvalId}`);
      }
      let settled = false;
      let resolvePromise: (decision: string) => void = () => {};

      const promise = new Promise<string>(resolve => {
        resolvePromise = decision => {
          if (settled) return;
          settled = true;
          resolve(decision);
        };
      });

      pending.set(approvalId, {
        approvalId,
        payload,
        resolve: resolvePromise,
      });

      return { approvalId, promise };
    },

    /**
     * 解除某个审批的等待
     *
     * 用法：用户操作路由中调用；runId 不匹配或审批不存在时抛错。
     * 审批不存在抛 ApprovalNotFoundError（路由层转 404），runId 不匹配抛 ApprovalRunMismatchError（转 409）。
     * @param {string} approvalId
     * @param {'approve'|'reject'|string} decision
     * @returns {Object} 审批时传入的 payload
     */
    resolve(approvalId: string, decision: string, expectedRunId: string) {
      const approval = pending.get(approvalId);
      if (!approval) {
        throw new ApprovalNotFoundError(approvalId);
      }
      if (approval.payload.runId !== expectedRunId) {
        throw new ApprovalRunMismatchError(approvalId, expectedRunId, approval.payload.runId);
      }
      pending.delete(approvalId);
      approval.resolve(decision);
      return approval.payload;
    },

    /** 列出指定运行的所有待审批（SSE 推送/前端轮询展示用） */
    listPendingForRun(runId: string) {
      return [...pending.values()]
        .map(serializeApproval)
        .filter(approval => approval.runId === runId);
    },

    /** 取指定运行的第一个待审批，没有则返回 null */
    getPendingForRun(runId: string) {
      return this.listPendingForRun(runId)[0] || null;
    },

    /** 拒绝所有待审批（取消/关闭运行时调用） */
    rejectAll() {
      for (const approval of pending.values()) {
        approval.resolve('reject');
      }
      pending.clear();
    },
  };
}
