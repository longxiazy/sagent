/**
 * Approval Store — 管理跨请求的用户审批/提问状态
 *
 * 审批流程是跨 HTTP 请求的协调：
 *   1. Agent 运行中 (POST /api/agent) → requestApproval → 创建 Promise 阻塞 agent 循环
 *   2. 用户操作 (POST /api/agent/approvals) → resolveApproval → 解除阻塞，agent 继续
 *
 * 调用场景：
 *   - agent/policy/approvals.js 的 createAgentAuthorizer 中调用 requestApproval
 *   - routes/agent.js 的 POST /api/agent/approvals 调用 resolveApproval
 *   - routes/agent.js 的 POST /api/agent/question 调用 resolveApproval（用户回答提问）
 *   - routes/agent.js 的 POST /api/agent/cancel → rejectAll(runId)（取消时只拒该 run 的待审批）
 *   - routes/agent.js 的 POST /api/agent finally → rejectAll(runId)（运行结束时清理本 run）
 *
 * 并发说明：多个 run 可能同时有待审批，因此 rejectAll 默认按 runId 过滤；
 * 只有关服等全局兜底场景才不传 runId 清空全部。
 */

function createApprovalId() {
  return `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createApprovalStore() {
  /** @type {Map<string, {approvalId: string, runId: string|null, payload: Object, resolve: Function}>} approvalId → 审批记录 */
  const pending = new Map();

  return {
    /**
     * 创建审批请求并返回阻塞 Promise
     *
     * @param {Object} payload - 审批上下文（step, action 等）
     * @param {string} [runId] - 发起审批的 run，用于并发时按 run 隔离 rejectAll
     * @returns {{ approvalId: string, promise: Promise<string> }}
     */
    request(payload = {}, runId = null) {
      const approvalId = createApprovalId();
      let settled = false;
      let resolvePromise;

      const promise = new Promise(resolve => {
        resolvePromise = decision => {
          if (settled) return;
          settled = true;
          resolve(decision);
        };
      });

      pending.set(approvalId, {
        approvalId,
        runId,
        payload,
        resolve: resolvePromise,
      });

      return { approvalId, promise };
    },

    /**
     * 解除某个审批的等待
     *
     * @param {string} approvalId
     * @param {'approve'|'reject'|string} decision
     * @returns {Object} 审批时传入的 payload
     */
    resolve(approvalId, decision) {
      const approval = pending.get(approvalId);
      if (!approval) {
        throw new Error(`审批不存在: ${approvalId}`);
      }
      pending.delete(approvalId);
      approval.resolve(decision);
      return approval.payload;
    },

    /**
     * 拒绝待审批（取消/关闭运行时调用）
     *
     * @param {string} [runId] - 只拒绝该 run 的待审批；不传则拒绝全部（关服/全局兜底）。
     *   并发多 run 时必须传 runId，否则会误杀其它 run 正在等待的审批。
     */
    rejectAll(runId?: string) {
      for (const approval of pending.values()) {
        if (runId != null && approval.runId !== runId) continue;
        approval.resolve('reject');
        pending.delete(approval.approvalId);
      }
    },
  };
}
