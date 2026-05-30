import { streamAgentRun, submitAgentApproval } from '../api/streams.js';
import { showAgentNotification } from '../notifications.js';
import { touchSession } from './useChatSessions.js';
import { PHONE_BREAKPOINT } from '../utils/constants.js';

// Agent 多 run 执行链路。
// - sendAgentTask: 发起一次 Agent 任务(可与其它任务并发)
// - stopAgent(runId): 取消指定 run
// - handleRollback(runId, targetStep): 回滚指定 run
// - handleApprovalDecision(runId, decision): 提交指定 run 的审批
//
// 关键约束:每个并发任务的事件写回必须绑定它**自己的** sessionId / runId,
// 绝不读全局 ref,否则多 run 并发会串台(写错 session / 取消错 run)。
export function useAgentTransport({
  selectedAgentModels,
  chatModel,
  agentStrategy,
  agentMemory,
  availableModels,
  textareaRef,
  // 多 run 运行时
  dispatch,
  getRun,
  abortControllersRef,
  // 全局 UI setters
  setInput,
  setRollbackLoading,
  setAgentMobileTab,
  setApprovalSubmitting,
  // helpers
  updateSession,
}) {
  const stopAgent = runId => {
    if (!runId) return;
    dispatch({ type: 'setStopping', runId, stopping: true });
    const run = getRun(runId);
    run?.pendingApproval?.resolve?.('reject');
    dispatch({ type: 'setApproval', runId, approval: null });
    fetch(`/api/agent/${runId}/cancel`, { method: 'POST' }).catch(() => {});
    // 给最后一两个 in-flight 事件一点缓冲再断 SSE
    setTimeout(() => abortControllersRef.current.get(runId)?.abort(), 1500);
  };

  // Agent 流程:聊天区只保留"任务 + 最终回答",中间步骤进 run.trace,由 AgentPanel 展示。
  const sendAgentTask = async (text, sessionId, extraBody) => {
    const isRetry = !!extraBody?.fromCheckpoint;
    const tempKey = `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let localRunId = isRetry ? (extraBody?.fromCheckpoint?.runId || null) : null;
    const controller = new AbortController();

    // 取当前 session 的消息快照(用于 history 与占位消息更新)
    let sessionMessages = [];
    updateSession(sessionId, s => { sessionMessages = s.messages || []; return s; });
    const history = isRetry
      ? sessionMessages
      : [...sessionMessages, { role: 'user', content: text, ts: Date.now() }];

    // 注册 run 运行时状态 + abortController
    dispatch({
      type: 'start',
      tempKey,
      runId: localRunId,
      sessionId,
      startedAt: Date.now(),
      lastTask: text,
    });
    abortControllersRef.current.set(localRunId || tempKey, controller);

    if (!isRetry) {
      updateSession(sessionId, s =>
        touchSession(s, {
          messages: [...history, { role: 'assistant', content: 'Desktop Agent 正在执行任务,请稍候…', ts: Date.now() }],
          agentTrace: [],
          agentRunId: null,
        })
      );
      setInput('');
    } else {
      const cpStep = extraBody?.fromCheckpoint?.step;
      updateSession(sessionId, s => {
        const msgs = [...s.messages];
        const stepInfo = cpStep ? `从第 ${cpStep} 步` : '';
        msgs.push({ role: 'assistant', content: `Desktop Agent 正在${stepInfo}重新执行任务:${text}`, ts: Date.now() });
        return touchSession(s, { messages: msgs });
      });
    }

    // 把 abortController 的 key 从 tempKey 迁移到真实 runId
    const rebindController = runId => {
      if (localRunId === runId) return;
      const prevKey = localRunId || tempKey;
      const ac = abortControllersRef.current.get(prevKey);
      abortControllersRef.current.delete(prevKey);
      if (ac) abortControllersRef.current.set(runId, ac);
      localRunId = runId;
    };

    const traceRunId = () => localRunId || tempKey;

    try {
      await streamAgentRun({
        task: text,
        model: selectedAgentModels.length > 0 ? selectedAgentModels[0] : chatModel,
        models: selectedAgentModels.length > 0
          ? selectedAgentModels.filter(m => availableModels.some(available => available.id === m))
          : [chatModel],
        strategy: selectedAgentModels.length > 1 ? agentStrategy : 'race',
        memory: agentMemory,
        signal: controller.signal,
        messages: isRetry ? [] : sessionMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        ...extraBody,
        async onEvent(event) {
          // 首个带 runId 的事件:绑定真实 runId,迁移 reducer 分片和 controller
          if (event.runId && event.runId !== localRunId) {
            dispatch({ type: 'bindRunId', tempKey: traceRunId(), runId: event.runId, sessionId });
            rebindController(event.runId);
            updateSession(sessionId, s => touchSession(s, { agentRunId: event.runId }));
          }
          const rid = localRunId || event.runId || tempKey;

          dispatch({ type: 'appendTrace', runId: rid, event });

          if (event.type === 'approval_required') {
            showAgentNotification({ runId: event.runId, approvalId: event.approvalId, message: event.message || '需要审批', kind: 'approval' });
            dispatch({ type: 'setApproval', runId: rid, approval: { ...event, resolve: () => {} } });
            return;
          }
          if (event.type === 'question_required') {
            showAgentNotification({ runId: event.runId, approvalId: event.approvalId, message: event.action?.question || event.message || 'Agent 有问题需要你回答', kind: 'question' });
            dispatch({ type: 'setQuestion', runId: rid, question: { ...event, resolve: () => {} } });
            return;
          }
          if (event.type === 'approval_result') {
            dispatch({ type: 'setApproval', runId: rid, approval: null });
          }
          if (event.type === 'user_response') {
            dispatch({ type: 'setQuestion', runId: rid, question: null });
          }
          if (event.type === 'rollback') {
            const run = getRun(rid);
            if (run) {
              const target = event.targetStep;
              const filtered = run.trace.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step <= target);
              dispatch({ type: 'setTrace', runId: rid, trace: filtered });
            }
            return;
          }
          if (event.type === 'done') {
            showAgentNotification({ runId: event.runId, message: event.answer || 'Agent 已完成任务', kind: 'success' });
            const run = getRun(rid);
            updateSession(sessionId, s => {
              const nextMessages = [...s.messages];
              const lastMsg = nextMessages[nextMessages.length - 1];
              if (lastMsg?.content?.includes('从检查点')) {
                nextMessages.push({ role: 'assistant', content: event.answer || 'Agent 已完成任务。', ts: Date.now() });
              } else {
                nextMessages[nextMessages.length - 1] = { role: 'assistant', content: event.answer || 'Agent 已完成任务。', ts: Date.now() };
              }
              return touchSession(s, { messages: nextMessages, agentTrace: run?.trace || [], agentRunId: rid });
            });
          }
          if (event.type === 'error') {
            showAgentNotification({ runId: event.runId, message: event.error || 'Agent 执行失败', kind: 'failure' });
            const run = getRun(rid);
            updateSession(sessionId, s => {
              const nextMessages = [...s.messages];
              const lastMsg = nextMessages[nextMessages.length - 1];
              if (lastMsg?.content?.includes('从检查点')) {
                nextMessages.push({ role: 'assistant', content: `⚠️ Desktop Agent 失败:${event.error}`, ts: Date.now() });
              } else {
                nextMessages[nextMessages.length - 1] = { role: 'assistant', content: `⚠️ Desktop Agent 失败:${event.error}`, ts: Date.now() };
              }
              return touchSession(s, { messages: nextMessages, agentTrace: run?.trace || [], agentRunId: rid });
            });
          }
        },
      });
    } catch (err) {
      const isPageUnload = err.name === 'AbortError'
        || controller.signal.aborted
        || (err.name === 'TypeError' && /load failed|network|fetch/i.test(err.message));
      if (!isPageUnload) {
        const detail = err.stack ? `\n\`\`\`\n${err.stack.split('\n').slice(0, 3).join('\n')}\n\`\`\`` : '';
        updateSession(sessionId, s => {
          const nextMessages = [...s.messages];
          nextMessages[nextMessages.length - 1] = { role: 'assistant', content: `⚠️ Desktop Agent 请求失败:${err.message}${detail}` };
          return touchSession(s, { messages: nextMessages });
        });
      }
    } finally {
      const rid = localRunId || tempKey;
      const run = getRun(rid);
      // SSE 可能断连导致 done/error 丢失,检查占位消息是否未被替换
      const doneEvent = run?.trace.find(e => e.type === 'done');
      const errorEvent = run?.trace.find(e => e.type === 'error');
      updateSession(sessionId, s => {
        const msgs = s.messages;
        const lastIdx = msgs.length - 1;
        const isPlaceholder = lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].content.includes('正在执行任务');
        if (doneEvent || errorEvent) {
          if (isPlaceholder) {
            const next = [...msgs];
            next[lastIdx] = doneEvent
              ? { role: 'assistant', content: doneEvent.answer || 'Agent 已完成任务。', ts: Date.now() }
              : { role: 'assistant', content: `⚠️ Desktop Agent 失败:${errorEvent.error || '连接中断'}`, ts: Date.now() };
            return touchSession(s, { messages: next, agentTrace: run?.trace || [], agentRunId: rid });
          }
          return touchSession(s, { agentTrace: run?.trace || [], agentRunId: rid });
        }
        if (isPlaceholder) {
          const next = [...msgs];
          next[lastIdx] = { role: 'assistant', content: '⚠️ Desktop Agent 连接中断,未收到执行结果。', ts: Date.now() };
          return touchSession(s, { messages: next, agentTrace: run?.trace || [], agentRunId: rid });
        }
        return touchSession(s, { agentTrace: run?.trace || [], agentRunId: rid });
      });

      abortControllersRef.current.delete(rid);
      dispatch({ type: 'finish', runId: rid });
      if (window.innerWidth < PHONE_BREAKPOINT) setAgentMobileTab('chat');
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleRollback = async (runId, targetStep) => {
    if (!runId) return;
    const run = getRun(runId);
    setRollbackLoading(true);
    try {
      if (run?.running) {
        const res = await fetch('/api/agent/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStep }),
        });
        const data = await res.json();
        if (!res.ok) alert(data.error || '回滚失败');
      } else {
        // 已结束的任务:过滤 trace 后从 checkpoint 重启
        if (run) {
          const filtered = run.trace.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step < targetStep);
          dispatch({ type: 'setTrace', runId, trace: filtered });
        }
        await sendAgentTask(run?.lastTask || '继续任务', run?.sessionId, { fromCheckpoint: { runId, step: targetStep } });
      }
    } catch {
      alert('回滚请求失败');
    } finally {
      setRollbackLoading(false);
    }
  };

  const handleApprovalDecision = async (runId, decision) => {
    const run = getRun(runId);
    const request = run?.pendingApproval;
    if (!request) return;
    setApprovalSubmitting(true);
    try {
      await submitAgentApproval({ runId: request.runId, approvalId: request.approvalId, decision });
      request.resolve?.(decision);
      dispatch({ type: 'setApproval', runId, approval: null });
    } catch (err) {
      window.alert(`提交审批失败:${err.message}`);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  return { sendAgentTask, stopAgent, handleRollback, handleApprovalDecision };
}
