import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

// 多 run 并发的运行时状态层。
//
// 设计:run 的活跃态(running/trace/pendingApproval/abortController)是临时运行时
// 数据,不进 session 对象(否则每个 SSE 事件触发整个 sessions 数组重渲染,且
// abortController 无法序列化)。这里用 useReducer 管 `byId: Map<runId, RunState>`,
// 每个事件只更新对应 runId 的分片;同时把真值镜像到 runsRef,供 transport 闭包
// 随时读最新(避免闭包捕获到过期的 state)。
//
// session.agentRunId 仍是唯一持久字段,作为 run ↔ session 的桥接。

function makeRunState({ runId, sessionId, startedAt, reconnected = false }) {
  return {
    runId: runId ?? null,
    sessionId: sessionId ?? null,
    trace: [],
    running: true,
    stopping: false,
    startedAt: startedAt ?? Date.now(),
    pendingApproval: null,
    pendingQuestion: null,
    lastTask: null,
    reconnected,
  };
}

function traceKey(event) {
  return `${event.type}:${event.step ?? ''}:${event.stage ?? ''}:${event.model ?? ''}`;
}

function runsReducer(state, action) {
  const byId = new Map(state.byId);

  switch (action.type) {
    case 'start': {
      // 任务发起时还没有后端 runId,先用临时 key 占位,bindRunId 时迁移。
      const key = action.runId || action.tempKey;
      byId.set(key, {
        ...makeRunState({
          runId: action.runId || null,
          sessionId: action.sessionId,
          startedAt: action.startedAt,
          reconnected: action.reconnected,
        }),
        lastTask: action.lastTask ?? null,
      });
      return { byId };
    }
    case 'bindRunId': {
      // 首个带 runId 的事件到达:把临时 key 的 RunState 迁移到真实 runId。
      const prev = byId.get(action.tempKey) || byId.get(action.runId);
      if (!prev) return state;
      if (action.tempKey !== action.runId) byId.delete(action.tempKey);
      byId.set(action.runId, { ...prev, runId: action.runId, sessionId: action.sessionId ?? prev.sessionId });
      return { byId };
    }
    case 'appendTrace': {
      const run = byId.get(action.runId);
      if (!run) return state;
      // per-run 去重(同 type+step+stage+model 只留一条)
      if (run.trace.some(e => traceKey(e) === traceKey(action.event))) return state;
      byId.set(action.runId, { ...run, trace: [...run.trace, action.event] });
      return { byId };
    }
    case 'setTrace': {
      const run = byId.get(action.runId);
      if (!run) return state;
      byId.set(action.runId, { ...run, trace: action.trace });
      return { byId };
    }
    case 'setApproval': {
      const run = byId.get(action.runId);
      if (!run) return state;
      byId.set(action.runId, { ...run, pendingApproval: action.approval });
      return { byId };
    }
    case 'setQuestion': {
      const run = byId.get(action.runId);
      if (!run) return state;
      byId.set(action.runId, { ...run, pendingQuestion: action.question });
      return { byId };
    }
    case 'setStopping': {
      const run = byId.get(action.runId);
      if (!run) return state;
      byId.set(action.runId, { ...run, stopping: action.stopping });
      return { byId };
    }
    case 'setStartedAt': {
      const run = byId.get(action.runId);
      if (!run) return state;
      byId.set(action.runId, { ...run, startedAt: action.startedAt });
      return { byId };
    }
    case 'finish': {
      const run = byId.get(action.runId);
      if (!run) return state;
      byId.set(action.runId, { ...run, running: false, stopping: false, pendingApproval: null, pendingQuestion: null });
      return { byId };
    }
    case 'remove': {
      byId.delete(action.runId);
      return { byId };
    }
    default:
      return state;
  }
}

export function useAgentRun() {
  // 真正全局的 UI 偏好态(与具体 run 无关)
  const [streaming, setStreaming] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [agentMobileTab, setAgentMobileTab] = useState('agent');

  const [runsState, rawDispatch] = useReducer(runsReducer, { byId: new Map() });

  // runsRef 持有最新真值,供 transport 的异步闭包读取(不受 React 渲染时序影响)。
  const runsRef = useRef(runsState);
  const dispatch = useCallback(action => {
    rawDispatch(action);
    runsRef.current = runsReducer(runsRef.current, action);
    return runsRef.current;
  }, []);

  // 每个 run 的 AbortController 不进 reducer(不可序列化),单独用 ref Map 持有。
  const abortControllersRef = useRef(new Map());
  // 触摸手势 ref(全局,与 run 无关)
  const touchStartRef = useRef(null);

  const getRun = useCallback(runId => (runId ? runsRef.current.byId.get(runId) || null : null), []);

  return {
    // 全局 UI 态
    streaming,
    setStreaming,
    approvalSubmitting,
    setApprovalSubmitting,
    agentCollapsed,
    setAgentCollapsed,
    showMemoryPanel,
    setShowMemoryPanel,
    rollbackLoading,
    setRollbackLoading,
    agentMobileTab,
    setAgentMobileTab,
    // 多 run 运行时
    runsState,
    dispatch,
    runsRef,
    getRun,
    abortControllersRef,
    touchStartRef,
  };
}
