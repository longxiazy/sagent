import { streamAgentRun, submitAgentApproval } from '../api/streams.js';
import { showAgentNotification } from '../notifications.js';
import { touchSession } from './useChatSessions.js';
import { PHONE_BREAKPOINT } from '../utils/constants.js';

// Agent 流程的执行链路：
// - sendAgentTask: 发起一次 Agent 任务（含 retry from checkpoint）
// - stopAgent: 取消运行中的 Agent
// - handleRollback: 回滚到某一步（正在跑时调用 /api/agent/rollback，已结束时重启）
// - handleApprovalDecision: 提交审批结果
export function useAgentTransport({
  activeSession,
  messages,
  agentTrace,
  agentRunning,
  selectedAgentModels,
  chatModel,
  agentStrategy,
  agentMemory,
  availableModels,
  // refs
  agentRunIdRef,
  agentAbortRef,
  approvalRequestRef,
  questionRequestRef,
  lastAgentTaskRef,
  textareaRef,
  // setters
  setInput,
  setAgentTrace,
  setAgentRunning,
  setAgentStopping,
  setAgentStartedAt,
  setPendingApproval,
  setPendingQuestion,
  setReconnectedRun,
  setRollbackLoading,
  setAgentMobileTab,
  setAgentRunId,
  setApprovalSubmitting,
  // helpers
  updateSession,
}) {
  const stopAgent = () => {
    // 停止 Agent 既要通知后端取消 run，也要尽快把前端 SSE 断掉。
    // 这里给一个很短的缓冲时间，让最后一两个 in-flight 事件有机会落到 UI。
    setAgentStopping(true);
    approvalRequestRef.current?.resolve?.('reject');
    setPendingApproval(null);
    const rid = agentRunIdRef.current;
    if (rid) {
      fetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: rid }),
      }).catch(() => {});
    }
    // Abort SSE after a short grace period for in-flight results
    setTimeout(() => agentAbortRef.current?.abort(), 1500);
  };

  // Agent 流程和普通对话不一样：聊天区只保留"任务 + 最终回答"，
  // 详细的中间步骤全部写进 agentTrace，再由 AgentPanel 单独展示。
  const sendAgentTask = async (text, extraBody) => {
    const sessionId = activeSession.id;
    const isRetry = !!extraBody?.fromCheckpoint;
    lastAgentTaskRef.current = text;
    const history = isRetry ? messages : [...messages, { role: 'user', content: text, ts: Date.now() }];

    if (!isRetry) {
      updateSession(sessionId, session =>
        touchSession(session, {
          messages: [...history, { role: 'assistant', content: 'Desktop Agent 正在执行任务，请稍候…', ts: Date.now() }],
          agentTrace: [],
          agentRunId: null,
        })
      );
      setInput('');
      setAgentTrace([]);
      agentRunIdRef.current = null;
      setAgentRunId(null);
    } else {
      // Retry from checkpoint — keep filtered trace (handleRollback already removed steps > target)
      const cpStep = extraBody?.fromCheckpoint?.step;
      updateSession(sessionId, session => {
        const msgs = [...session.messages];
        const stepInfo = cpStep ? `从第 ${cpStep} 步` : '';
        msgs.push({ role: 'assistant', content: `Desktop Agent 正在${stepInfo}重新执行任务：${text}`, ts: Date.now() });
        return touchSession(session, { messages: msgs });
      });
    }
    setAgentStartedAt(Date.now());
    setAgentRunning(true);
    setPendingApproval(null);

    const controller = new AbortController();
    agentAbortRef.current = controller;

    try {
      await streamAgentRun({
        task: text,
        // Agent 至少要有一个主模型。多模型时第一个模型作为主请求参数，
        // 完整模型集合再通过 models 传给后端做并发规划。
        model: selectedAgentModels.length > 0 ? selectedAgentModels[0] : chatModel,
        models: selectedAgentModels.length > 0
          ? selectedAgentModels.filter(m => availableModels.some(available => available.id === m))
          : [chatModel],
        strategy: selectedAgentModels.length > 1 ? agentStrategy : 'race',
        memory: agentMemory,
        signal: controller.signal,
        messages: isRetry ? [] : messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        ...extraBody,
        async onEvent(event) {
          console.log(`[AgentUI] event type=${event.type} step=${event.step ?? '-'} stage=${event.stage ?? '-'} model=${event.model || '-'}`);
          setAgentTrace(prev => {
            // Deduplicate: same type+step+stage+model already exists
            const key = `${event.type}:${event.step ?? ''}:${event.stage ?? ''}:${event.model ?? ''}`;
            if (prev.some(e => `${e.type}:${e.step ?? ''}:${e.stage ?? ''}:${e.model ?? ''}` === key)) {
              console.log(`[AgentUI] DEDUP skipped: ${key}`);
              return prev;
            }
            return [...prev, event];
          });

          if (event.runId && event.runId !== agentRunIdRef.current) {
            agentRunIdRef.current = event.runId;
            setAgentRunId(event.runId);
            updateSession(sessionId, session => touchSession(session, { agentRunId: event.runId }));
          }

          if (event.type === 'approval_required') {
            showAgentNotification({
              runId: event.runId,
              approvalId: event.approvalId,
              message: event.message || '需要审批',
              kind: 'approval',
            });
            // 不要 await：决策完成统一靠后端发的 approval_result event 清理 state，
            // 否则 SSE 处理会卡在 await 上、把 approval_result 事件也一起阻塞掉。
            approvalRequestRef.current = { ...event, resolve: () => {} };
            setPendingApproval(event);
            return;
          }

          if (event.type === 'question_required') {
            showAgentNotification({
              runId: event.runId,
              approvalId: event.approvalId,
              message: event.action?.question || event.message || 'Agent 有问题需要你回答',
              kind: 'question',
            });
            // 同上：交给 user_response event 兜底清理
            questionRequestRef.current = { ...event, resolve: () => {} };
            setPendingQuestion(event);
            return;
          }

          if (event.type === 'approval_result') {
            approvalRequestRef.current = null;
            setPendingApproval(null);
          }

          if (event.type === 'user_response') {
            questionRequestRef.current = null;
            setPendingQuestion(null);
          }

          if (event.type === 'rollback') {
            setAgentTrace(prev => {
              const target = event.targetStep;
              return prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step <= target);
            });
            return;
          }

          if (event.type === 'done') {
            setAgentTrace(prev => {
              updateSession(sessionId, session => {
                const nextMessages = [...session.messages];
                const lastMsg = nextMessages[nextMessages.length - 1];
                // Keep retry placeholder, append result as new message
                if (lastMsg?.content?.includes('从检查点')) {
                  nextMessages.push({ role: 'assistant', content: event.answer || 'Agent 已完成任务。', ts: Date.now() });
                } else {
                  nextMessages[nextMessages.length - 1] = {
                    role: 'assistant',
                    content: event.answer || 'Agent 已完成任务。',
                    ts: Date.now(),
                  };
                }
                return touchSession(session, { messages: nextMessages, agentTrace: prev, agentRunId: agentRunIdRef.current });
              });
              return prev;
            });
          }

          if (event.type === 'error') {
            setAgentTrace(prev => {
              updateSession(sessionId, session => {
                const nextMessages = [...session.messages];
                const lastMsg = nextMessages[nextMessages.length - 1];
                if (lastMsg?.content?.includes('从检查点')) {
                  nextMessages.push({ role: 'assistant', content: `⚠️ Desktop Agent 失败：${event.error}`, ts: Date.now() });
                } else {
                  nextMessages[nextMessages.length - 1] = {
                    role: 'assistant',
                    content: `⚠️ Desktop Agent 失败：${event.error}`,
                    ts: Date.now(),
                  };
                }
                return touchSession(session, { messages: nextMessages, agentTrace: prev, agentRunId: agentRunIdRef.current });
              });
              return prev;
            });
          }
        },
      });
    } catch (err) {
      const isPageUnload = err.name === 'AbortError'
        || controller.signal.aborted
        || (err.name === 'TypeError' && /load failed|network|fetch/i.test(err.message));
      if (isPageUnload) {
        // Page navigation cancelled the request — don't show error
      } else {
        const detail = err.stack ? `\n\`\`\`\n${err.stack.split('\n').slice(0, 3).join('\n')}\n\`\`\`` : '';
        updateSession(sessionId, session => {
          const nextMessages = [...session.messages];
          nextMessages[nextMessages.length - 1] = {
            role: 'assistant',
            content: `⚠️ Desktop Agent 请求失败：${err.message}${detail}`,
          };

          return touchSession(session, { messages: nextMessages });
        });
      }
    } finally {
      // SSE 可能断连导致 done/error 事件丢失，检查占位消息是否未被替换
      setAgentTrace(prev => {
        const doneEvent = prev.find(e => e.type === 'done');
        const errorEvent = prev.find(e => e.type === 'error');
        if (doneEvent || errorEvent) {
          updateSession(sessionId, session => {
            const msgs = session.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].content.includes('正在执行任务')) {
              const next = [...msgs];
              if (doneEvent) {
                next[lastIdx] = { role: 'assistant', content: doneEvent.answer || 'Agent 已完成任务。', ts: Date.now() };
              } else {
                next[lastIdx] = { role: 'assistant', content: `⚠️ Desktop Agent 失败：${errorEvent.error || '连接中断'}`, ts: Date.now() };
              }
              return touchSession(session, { messages: next, agentTrace: prev, agentRunId: agentRunIdRef.current });
            }
            return touchSession(session, { agentTrace: prev, agentRunId: agentRunIdRef.current });
          });
        } else if (prev.length === 0 || !prev.some(e => e.type === 'done' || e.type === 'error')) {
          // No events received at all or SSE disconnected without done/error
          updateSession(sessionId, session => {
            const msgs = session.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].content.includes('正在执行任务')) {
              const next = [...msgs];
              next[lastIdx] = { role: 'assistant', content: '⚠️ Desktop Agent 连接中断，未收到执行结果。', ts: Date.now() };
              return touchSession(session, { messages: next, agentTrace: prev, agentRunId: agentRunIdRef.current });
            }
            return touchSession(session, { agentTrace: prev, agentRunId: agentRunIdRef.current });
          });
        }
        return prev;
      });

      agentAbortRef.current = null;
      // Keep agentRunIdRef for post-task checkpoint queries
      setAgentRunning(false);
      setAgentStopping(false);
      setReconnectedRun(false);
      setPendingApproval(null);
      approvalRequestRef.current = null;
      if (window.innerWidth < PHONE_BREAKPOINT) setAgentMobileTab('chat');
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleRollback = async targetStep => {
    const rid = agentRunIdRef.current;
    console.log('[Rollback] targetStep:', targetStep, 'runId:', rid, 'running:', agentRunning, 'traceLen:', agentTrace.length);
    if (!rid) {
      console.warn('[Rollback] no runId, cannot rollback');
      return;
    }
    setRollbackLoading(true);
    try {
      if (agentRunning) {
        // Running task — use pendingRollback for in-place rollback
        console.log('[Rollback] calling POST /api/agent/rollback');
        const res = await fetch('/api/agent/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStep }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || '回滚失败');
        }
      } else {
        // Finished task — restart from checkpoint
        console.log('[Rollback] finished task, filtering trace and restarting from checkpoint');
        setAgentTrace(prev => {
          const filtered = prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step < targetStep);
          console.log('[Rollback] trace filtered:', prev.length, '->', filtered.length);
          return filtered;
        });
        await sendAgentTask(lastAgentTaskRef.current || '继续任务', {
          fromCheckpoint: { runId: rid, step: targetStep },
        });
      }
    } catch {
      alert('回滚请求失败');
    } finally {
      setRollbackLoading(false);
    }
  };

  const handleApprovalDecision = async decision => {
    const request = approvalRequestRef.current;
    if (!request) {
      return;
    }

    setApprovalSubmitting(true);
    try {
      await submitAgentApproval({
        runId: request.runId,
        approvalId: request.approvalId,
        decision,
      });
      request.resolve(decision);
      approvalRequestRef.current = null;
      setPendingApproval(null);
    } catch (err) {
      window.alert(`提交审批失败：${err.message}`);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  return { sendAgentTask, stopAgent, handleRollback, handleApprovalDecision };
}
