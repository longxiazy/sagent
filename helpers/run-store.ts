/**
 * Agent Run Store — 管理 Agent 运行记录和 SSE 事件存储
 *
 * 调用场景：
 *   - server.js 启动时创建唯一实例
 *   - 传入 routes/agent.js 使用
 *   - POST /api/agent → createRun → 整个运行周期 → closeRun
 *   - POST /api/agent/cancel → cancelRun
 *   - GET /api/agent/active → getActiveRun（前端刷新后检测是否有进行中的任务）
 *   - GET /api/agent/stream/:runId → getRun（SSE 重连回放事件）
 *
 * 生命周期：
 *   createRun (running)
 *     → addEvent × N（每个 SSE 事件追加到 events 数组）
 *     → cancelRun（可选，用户中途取消）
 *     → closeRun (done)
 *     → 5 分钟后自动从内存中删除（给 SSE 重连留窗口）
 */

function createRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 运行结束后保留在内存中的时长，超时自动清理 */
const RUN_TTL_MS = 5 * 60 * 1000;

export function createAgentRunStore() {
  /** @type {Map<string, RunRecord>} runId → 运行记录 */
  const runs = new Map();

  function getRun(runId) {
    return runs.get(runId) || null;
  }

  return {
    /**
     * 创建新的运行记录
     * 调用时机：POST /api/agent 收到任务后立即创建
     */
    createRun(meta = {}, startedAt = Date.now(), existingRunId) {
      const runId = existingRunId || createRunId();
      const record = {
        runId,
        startedAt,
        cancelAc: new AbortController(),
        events: [],
        status: 'running',
        meta,
      };
      runs.set(runId, record);
      return record;
    },

    getRun,

    /**
     * 获取当前正在运行的 Agent（最多一个）
     * 调用时机：GET /api/agent/active 前端刷新后检测是否有进行中的任务
     */
    getActiveRun() {
      for (const run of runs.values()) {
        if (run.status === 'running' && !run.cancelAc.signal.aborted) {
          return run;
        }
      }
      return null;
    },

    /**
     * 追加 SSE 事件到运行记录
     * 调用时机：每次 sendEvent 都会同时 addEvent，用于 SSE 重连时回放
     */
    addEvent(runId, event) {
      const run = getRun(runId);
      if (run) {
        run.events.push(event);
      }
    },

    /**
     * 取消运行
     * 调用时机：POST /api/agent/cancel 用户主动取消任务
     * runtime 循环中通过 isCancelled() 检测并抛出异常退出
     */
    cancelRun(runId) {
      const run = getRun(runId);
      if (!run) return;
      run.cancelAc.abort();
    },

    /**
     * 关闭运行（完成或出错后调用）
     * 调用时机：POST /api/agent 的 finally 块
     * 清理重连写入器，标记 status='done'，
     * 然后启动 5 分钟倒计时自动删除该记录
     */
    closeRun(runId) {
      const run = getRun(runId);
      if (!run) return;
      run._reconnectWriters = null;
      run.status = 'done';
      setTimeout(() => runs.delete(runId), RUN_TTL_MS);
    },
  };
}
