/**
 * Agent Run Store — 管理 Agent 运行记录和 SSE 事件存储
 *
 * 调用场景：
 *   - server.ts 启动时创建唯一实例并注入 Agent 路由/runner
 *   - POST /api/agent → tryCreateRun → 整个运行周期 → closeRun
 *   - checkpoint 恢复 → createRun(existingRunId) → closeRun
 *   - POST /api/agent/cancel → cancelRun
 *   - GET /api/agent/active → getActiveRun（前端刷新后检测是否有进行中的任务）
 *   - GET /api/agent/stream/:runId → getRun（SSE 重连回放事件）
 *
 * 生命周期：
 *   createRun (running)
 *     → addEvent × N（每个 SSE 事件追加到 events 数组）
 *     → cancelRun（可选，running → cancelling）
 *     → closeRun（completed / failed / cancelled）
 *     → 普通 run 保留 5 分钟给 SSE 重连；隐私 run 立即从内存删除
 */

import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUS_TRANSITIONS,
  type AgentEvent,
  type AgentRunStore,
  type RunMeta,
  type RunRecord,
  type RunStatus,
  type TerminalRunStatus,
} from '../agent/core/contracts.ts';
import { createPersistenceQueue } from './persistence-queue.ts';

function createRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 普通运行结束后保留在内存中的时长，超时自动清理 */
const RUN_TTL_MS = 5 * 60 * 1000;

export function createAgentRunStore({
  maxEvents = Number(process.env.AGENT_RUN_MAX_EVENTS) || 2000,
}: { maxEvents?: number } = {}): AgentRunStore {
  const runs = new Map<string, RunRecord>();
  const eventLimit = Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : 2000;

  function insertRun(
    meta: RunMeta,
    startedAt: number,
    existingRunId: string | undefined,
    status: RunStatus,
    initialEventSeq = 1,
  ): RunRecord {
    const runId = existingRunId || createRunId();
    const existing = runs.get(runId);
    if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
    const record: RunRecord = {
      runId,
      startedAt,
      cancelAc: new AbortController(),
      events: [],
      status,
      meta,
      pendingRollback: null,
      nextEventSeq: Math.max(1, Math.floor(initialEventSeq)),
      persistence: createPersistenceQueue(),
    };
    runs.set(runId, record);
    return record;
  }

  function getRun(runId: string): RunRecord | null {
    return runs.get(runId) || null;
  }

  function transitionRun(runId: string, nextStatus: RunStatus): RunRecord | null {
    const run = getRun(runId);
    if (!run || run.status === nextStatus) return run;
    const allowed = RUN_STATUS_TRANSITIONS[run.status];
    if (!allowed.has(nextStatus)) {
      throw new Error(`非法 Run 状态迁移: ${run.status} -> ${nextStatus} (${runId})`);
    }
    run.status = nextStatus;
    return run;
  }

  function getActiveRun(): RunRecord | null {
    for (const run of runs.values()) {
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        return run;
      }
    }
    return null;
  }

  return {
    /**
     * 创建新的运行记录
     * 调用时机：checkpoint 恢复，或无需原子占锁的内部调用
     */
    createRun(meta: RunMeta = {}, startedAt = Date.now(), existingRunId?: string, initialEventSeq = 1) {
      return insertRun(meta, startedAt, existingRunId, 'running', initialEventSeq);
    },

    /**
     * 原子地检查运行锁并预留一个 starting Run。
     * 本方法不包含 await；在单个 Node.js 进程内，检查和写入不会被另一个请求插入。
     */
    tryCreateRun(meta: RunMeta = {}, startedAt = Date.now(), existingRunId?: string, initialEventSeq = 1) {
      const activeRun = getActiveRun();
      if (activeRun) {
        return { ok: false as const, activeRun };
      }
      return { ok: true as const, run: insertRun(meta, startedAt, existingRunId, 'starting', initialEventSeq) };
    },

    getRun,

    /**
     * 获取当前占用运行锁的 Agent（包括 waiting_approval / cancelling）
     * 调用时机：GET /api/agent/active 前端刷新后检测是否有进行中的任务
     */
    getActiveRun,

    getActiveRuns() {
      return Array.from(runs.values()).filter(run => ACTIVE_RUN_STATUSES.has(run.status));
    },

    getRunningRuns() {
      return Array.from(runs.values()).filter(run => ACTIVE_RUN_STATUSES.has(run.status));
    },

    /**
     * 追加 SSE 事件到运行记录
     * 调用时机：每次 sendEvent 都会同时 addEvent，用于 SSE 重连时回放
     */
    addEvent(runId: string, event: AgentEvent) {
      const run = getRun(runId);
      if (run) {
        const sequencedEvent = Number.isFinite(event.seq)
          ? event
          : { ...event, seq: run.nextEventSeq++ } as AgentEvent;
        if (Number.isFinite(sequencedEvent.seq)) {
          run.nextEventSeq = Math.max(run.nextEventSeq, Number(sequencedEvent.seq) + 1);
        }
        run.events.push(sequencedEvent);
        if (run.events.length > eventLimit) {
          run.events.splice(0, run.events.length - eventLimit);
        }
        return sequencedEvent;
      }
      return event;
    },

    /**
     * 取消运行
     * 调用时机：POST /api/agent/cancel 用户主动取消任务
     * runtime 循环中通过 isCancelled() 检测并抛出异常退出
     */
    transitionRun,

    cancelRun(runId: string) {
      const run = getRun(runId);
      if (!run || !ACTIVE_RUN_STATUSES.has(run.status)) return run;
      transitionRun(runId, 'cancelling');
      run.cancelAc.abort();
      return run;
    },

    /**
     * 关闭运行（完成或出错后调用）
     * 调用时机：新任务与 checkpoint 恢复的统一 cleanupAgentRun 收尾
     * 清理重连写入器，迁移到终态，
     * 普通 run 启动 5 分钟倒计时自动删除；隐私 run 立即清除内存事件和记录。
     */
    closeRun(runId: string, outcome?: TerminalRunStatus) {
      const run = getRun(runId);
      if (!run) return null;
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
      run._reconnectWriters = null;
      const terminalStatus = outcome || (run.status === 'cancelling' ? 'cancelled' : 'completed');
      transitionRun(runId, terminalStatus);
      if (run.meta?.privateMode === true) {
        // 隐私任务不提供终态重连窗口，避免事件和运行元数据继续留在进程内存。
        run.events.length = 0;
        runs.delete(runId);
        return run;
      }
      run.cleanupTimer = setTimeout(() => {
        if (runs.get(runId) === run) runs.delete(runId);
      }, RUN_TTL_MS);
      return run;
    },
  };
}
