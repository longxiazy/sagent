import { streamAgentRun, submitAgentApproval } from '../api/streams.js';
import { apiFetch } from '../api/http.js';
import { showAgentNotification } from '../notifications.js';
import { touchSession, upsertAgentRun } from './useChatSessions.js';
import { useT } from '../i18n/I18nProvider.jsx';
import { agentTraceEventKey, appendUniqueTraceEvent } from '../utils/agent-trace.js';
import { buildRunConversationHistory } from '../utils/agent-conversation.js';
import { buildAgentMetaFromSession } from '../utils/agent-stats.js';

function uniqueModelIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()))];
}

function getEventModels(event, fallbackModels) {
  const modelsUsed = uniqueModelIds(event?.meta?.models_used);
  return modelsUsed.length > 0 ? modelsUsed : fallbackModels;
}

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
  agentStrategy,
  agentMemory,
  agentPrivateMode,
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
  setAgentRunId,
  setApprovalSubmitting,
  // helpers
  updateSession,
}) {
  const t = useT();
  const stopAgent = () => {
    // 停止 Agent 既要通知后端取消 run，也要尽快把前端 SSE 断掉。
    // 这里给一个很短的缓冲时间，让最后一两个 in-flight 事件有机会落到 UI。
    setAgentStopping(true);
    approvalRequestRef.current?.resolve?.('reject');
    setPendingApproval(null);
    const rid = agentRunIdRef.current;
    if (rid) {
      apiFetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: rid }),
      }).catch(() => {});
    }
    // Abort SSE after a short grace period for in-flight results
    setTimeout(() => agentAbortRef.current?.abort(), 1500);
  };

  // Agent 流程里，消息区只保留"任务 + 最终回答"，
  // 详细的中间步骤全部写进 agentTrace，再由 AgentPanel 单独展示。
  const sendAgentTask = async (text, extraBody) => {
    const sessionId = activeSession.id;
    const isRetry = !!extraBody?.fromCheckpoint;
    const availableModelIds = new Set(availableModels.map(model => model.id));
    const selectedModelCandidates = uniqueModelIds(selectedAgentModels);
    const selectedModels = availableModels.length > 0
      ? selectedModelCandidates.filter(model => availableModelIds.has(model))
      : selectedModelCandidates;
    const runModels = selectedModels;
    const primaryModel = runModels[0];
    const runStrategy = runModels.length > 1 ? agentStrategy : 'race';
    if (runModels.length === 0) {
      window.alert?.(t('send.needModel'));
      return;
    }
    lastAgentTaskRef.current = text;
    const now = Date.now();
    const history = isRetry
      ? messages
      : [...messages, { role: 'user', content: text, ts: now, model: primaryModel, modelsUsed: runModels }];

    if (!isRetry) {
      updateSession(sessionId, session => {
        const archivedSession = upsertAgentRun(session, {
          runId: session.agentRunId,
          trace: session.agentTrace,
          meta: buildAgentMetaFromSession(session, session.agentTrace),
        });
        return touchSession(archivedSession, {
          messages: [...history, { role: 'assistant', content: t('agent.running'), pending: 'run', ts: now, model: primaryModel, modelsUsed: runModels }],
          model: primaryModel,
          modelsUsed: runModels,
          agentTrace: [],
          agentRunId: null,
          agentMeta: null,
        });
      });
      setInput('');
      setAgentTrace([]);
      agentRunIdRef.current = null;
      setAgentRunId(null);
    } else {
      // Retry from checkpoint — keep filtered trace (handleRollback already removed steps > target)
      const cpStep = extraBody?.fromCheckpoint?.step;
      updateSession(sessionId, session => {
        const msgs = [...session.messages];
        const stepInfo = cpStep ? t('agent.retryFromStep', { step: cpStep }) : '';
        msgs.push({ role: 'assistant', content: t('agent.retrying', { step: stepInfo, task: text }), pending: 'run', ts: Date.now(), model: primaryModel, modelsUsed: runModels });
        return touchSession(session, { messages: msgs, model: primaryModel, modelsUsed: runModels, agentMeta: null });
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
        model: primaryModel,
        models: runModels,
        strategy: runStrategy,
        memory: agentMemory,
        privateMode: agentPrivateMode,
        // 当前会话归属的项目，后端据此隔离记忆/文件根/trace/checkpoint。
        projectId: activeSession.projectId ?? null,
        sessionId,
        signal: controller.signal,
        // 重跑必须沿用与首跑相同的历史口径：清空会让模型丢失 task 里指代词的所指。
        messages: buildRunConversationHistory(messages, { isRetry, task: text }),
        ...extraBody,
        async onEvent(event) {
          console.log(`[AgentUI] event type=${event.type} step=${event.step ?? '-'} stage=${event.stage ?? '-'} model=${event.model || '-'}`);
          setAgentTrace(prev => {
            const key = agentTraceEventKey(event);
            const next = appendUniqueTraceEvent(prev, event);
            if (next === prev) {
              console.log(`[AgentUI] DEDUP skipped: ${key}`);
            }
            return next;
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
              message: event.message || t('agent.approvalNeeded'),
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
              message: event.action?.question || event.message || t('agent.questionNeeded'),
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
            showAgentNotification({
              runId: event.runId,
              message: event.answer || t('agent.done'),
              kind: 'success',
            });
            setAgentTrace(prev => {
              const nextTrace = appendUniqueTraceEvent(prev, event);
              updateSession(sessionId, session => {
                const nextMessages = [...session.messages];
                const modelsUsed = getEventModels(event, runModels);
                // 占位消息（pending:'run'）始终是最后一条助手消息，用结果替换它。
                nextMessages[nextMessages.length - 1] = {
                  role: 'assistant',
                  content: event.answer || t('agent.done'),
                  ts: Date.now(),
                  model: modelsUsed[0] || primaryModel,
                  modelsUsed,
                };
                const nextSession = {
                  ...session,
                  messages: nextMessages,
                  model: modelsUsed[0] || primaryModel,
                  modelsUsed,
                  agentTrace: nextTrace,
                  agentRunId: agentRunIdRef.current,
                };
                const agentMeta = buildAgentMetaFromSession(nextSession, nextTrace, {
                  task: text,
                  startedAt: now,
                  models: modelsUsed,
                  strategy: runStrategy,
                  status: event.quality?.status || event.meta?.status || 'done',
                  runId: agentRunIdRef.current,
                });
                return touchSession(upsertAgentRun({
                  ...nextSession,
                  agentMeta,
                }, {
                  runId: agentRunIdRef.current,
                  trace: nextTrace,
                  meta: agentMeta,
                }));
              });
              return nextTrace;
            });
          }

          if (event.type === 'error') {
            showAgentNotification({
              runId: event.runId,
              message: event.error || t('agent.failedShort'),
              kind: 'failure',
            });
            setAgentTrace(prev => {
              const nextTrace = appendUniqueTraceEvent(prev, event);
              updateSession(sessionId, session => {
                const nextMessages = [...session.messages];
                const modelsUsed = getEventModels(event, runModels);
                nextMessages[nextMessages.length - 1] = {
                  role: 'assistant',
                  content: t('agent.failed', { error: event.error || t('common.unknownError') }),
                  ts: Date.now(),
                  model: modelsUsed[0] || primaryModel,
                  modelsUsed,
                };
                const nextSession = {
                  ...session,
                  messages: nextMessages,
                  model: modelsUsed[0] || primaryModel,
                  modelsUsed,
                  agentTrace: nextTrace,
                  agentRunId: agentRunIdRef.current,
                };
                const agentMeta = buildAgentMetaFromSession(nextSession, nextTrace, {
                  task: text,
                  startedAt: now,
                  models: modelsUsed,
                  strategy: runStrategy,
                  status: event.error === 'Agent 已取消' ? 'cancelled' : 'error',
                  runId: agentRunIdRef.current,
                });
                return touchSession(upsertAgentRun({
                  ...nextSession,
                  agentMeta,
                }, {
                  runId: agentRunIdRef.current,
                  trace: nextTrace,
                  meta: agentMeta,
                }));
              });
              return nextTrace;
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
            content: t('agent.requestFailed', { error: err.message, detail }),
            ts: Date.now(),
            model: primaryModel,
            modelsUsed: runModels,
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
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].pending === 'run') {
              const next = [...msgs];
              const terminalEvent = doneEvent || errorEvent;
              const modelsUsed = getEventModels(terminalEvent, runModels);
              if (doneEvent) {
                next[lastIdx] = { role: 'assistant', content: doneEvent.answer || t('agent.done'), ts: Date.now(), model: modelsUsed[0] || primaryModel, modelsUsed };
              } else {
                next[lastIdx] = { role: 'assistant', content: t('agent.failed', { error: errorEvent.error || t('agent.connectionLostShort') }), ts: Date.now(), model: modelsUsed[0] || primaryModel, modelsUsed };
              }
              const nextSession = {
                ...session,
                messages: next,
                model: modelsUsed[0] || primaryModel,
                modelsUsed,
                agentTrace: prev,
                agentRunId: agentRunIdRef.current,
              };
              const agentMeta = buildAgentMetaFromSession(nextSession, prev, {
                task: text,
                startedAt: now,
                models: modelsUsed,
                strategy: runStrategy,
                status: doneEvent ? (doneEvent.quality?.status || doneEvent.meta?.status || 'done') : (errorEvent.error === 'Agent 已取消' ? 'cancelled' : 'error'),
                runId: agentRunIdRef.current,
              });
              return touchSession(upsertAgentRun({
                ...nextSession,
                agentMeta,
              }, {
                runId: agentRunIdRef.current,
                trace: prev,
                meta: agentMeta,
              }));
            }
            const terminalEvent = doneEvent || errorEvent;
            const modelsUsed = getEventModels(terminalEvent, runModels);
            const nextSession = {
              ...session,
              model: modelsUsed[0] || primaryModel,
              modelsUsed,
              agentTrace: prev,
              agentRunId: agentRunIdRef.current,
            };
            const agentMeta = buildAgentMetaFromSession(nextSession, prev, {
              task: text,
              startedAt: now,
              models: modelsUsed,
              strategy: runStrategy,
              status: doneEvent ? (doneEvent.quality?.status || doneEvent.meta?.status || 'done') : (errorEvent.error === 'Agent 已取消' ? 'cancelled' : 'error'),
              runId: agentRunIdRef.current,
            });
            return touchSession(upsertAgentRun({
              ...nextSession,
              agentMeta,
            }, {
              runId: agentRunIdRef.current,
              trace: prev,
              meta: agentMeta,
            }));
          });
        } else if (prev.length === 0 || !prev.some(e => e.type === 'done' || e.type === 'error')) {
          // No events received at all or SSE disconnected without done/error
          updateSession(sessionId, session => {
            const msgs = session.messages;
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant' && msgs[lastIdx].pending === 'run') {
              const next = [...msgs];
              next[lastIdx] = { role: 'assistant', content: t('agent.connectionLost'), ts: Date.now(), model: primaryModel, modelsUsed: runModels };
              return touchSession(session, {
                messages: next,
                model: primaryModel,
                modelsUsed: runModels,
                agentTrace: prev,
                agentRunId: agentRunIdRef.current,
                agentMeta: null,
              });
            }
            return touchSession(session, {
              model: primaryModel,
              modelsUsed: runModels,
              agentTrace: prev,
              agentRunId: agentRunIdRef.current,
              agentMeta: null,
            });
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
        const res = await apiFetch('/api/agent/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStep }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || t('rollback.failed'));
        }
      } else {
        // Finished task — restart from checkpoint
        console.log('[Rollback] finished task, filtering trace and restarting from checkpoint');
        setAgentTrace(prev => {
          const filtered = prev.filter(e => (e.step == null && e.type !== 'done' && e.type !== 'error') || e.step < targetStep);
          console.log('[Rollback] trace filtered:', prev.length, '->', filtered.length);
          return filtered;
        });
        await sendAgentTask(lastAgentTaskRef.current || t('agent.continueTask'), {
          fromCheckpoint: { runId: rid, step: targetStep },
        });
      }
    } catch {
      alert(t('rollback.requestFailed'));
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
      window.alert(t('approval.submitFailed', { error: err.message }));
    } finally {
      setApprovalSubmitting(false);
    }
  };

  return { sendAgentTask, stopAgent, handleRollback, handleApprovalDecision };
}
