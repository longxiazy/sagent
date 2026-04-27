/**
 * Runtime — Agent 的核心执行循环：observe → decide → authorize → execute → repeat
 *
 * 这是整个 Agent 系统的中枢，不依赖任何具体工具实现。
 * 通过注入函数（initialize, observe, decide, authorize, execute, cleanup）实现灵活组合。
 *
 * 循环流程：
 *   1. initialize()  — 初始化状态（创建浏览器会话等）
 *   2. observe()     — 观察当前环境（桌面/浏览器/文件系统）
 *   3. decide()      — LLM 决定下一步动作（调用 planner 或 claudeAgentPlan）
 *   4. authorize()   — 策略审批（safe 直接通过，confirm 需用户批准，blocked 直接拒绝）
 *   5. execute()     — 执行动作（路由到 browser/fs/terminal/macos 工具）
 *   6. 回到步骤 2，直到 decide 返回 finish 或达到 maxSteps
 *
 * 调用场景：
 *   - agent/desktop/agent.js 的 runDesktopAgent() 是唯一的调用方，
 *     注入所有具体实现后调用 runAgentRuntime({ ... })
 */

import { log } from "../../helpers/logger.js";

const MAX_HISTORY_STEPS = 64;

function compressHistory(history, maxSteps = MAX_HISTORY_STEPS) {
  if (history.length <= maxSteps) {
    return history;
  }
  const recent = history.slice(-maxSteps);
  const dropped = history.slice(0, -maxSteps);
  const summary = dropped
    .map(
      (h) =>
        `step ${h.step}: [${h.action?.type ?? "?"}] ${h.result ? `→ ${String(h.result).slice(0, 1000)}` : ""}`,
    )
    .join(" | ");
  return [
    {
      step: 0,
      type: "summary",
      text: `历史摘要（共${dropped.length}步）: ${summary}`,
    },
    ...recent,
  ];
}

const MAX_RETRIES_PER_STEP = 1;

export async function runAgentRuntime({
  task,
  maxSteps = 8,
  onEvent,
  isCancelled,
  initialize,
  observe,
  decide,
  authorize,
  execute,
  cleanup,
  shouldObserve,
  review,
  initialStep = 1,
  initialHistory = [],
  onCheckpoint = null,
}) {
  const history = initialHistory;
  let finalAnswer = "";
  const state = await initialize?.({ task, onEvent });

  try {
    for (let step = initialStep; step <= maxSteps; step += 1) {
      if (isCancelled?.()) {
        throw new Error("Agent 已取消");
      }

      const lastAction =
        history.length > 0 ? history[history.length - 1].action : null;
      const skipObservation = shouldObserve
        ? !shouldObserve(lastAction)
        : false;
      const observation = skipObservation
        ? { skipped: true, reason: "上一步为文件/终端操作，跳过观察" }
        : await observe(state, {
            task,
            step,
            history,
          });

      onEvent?.({
        type: "step",
        step,
        stage: "observe",
        observation,
      });

      const compactHistory = compressHistory(history, MAX_HISTORY_STEPS);

      const decision = await decide({
        task,
        step,
        history: compactHistory,
        observation,
        state,
      });

      if (isCancelled?.()) {
        throw new Error("Agent 已取消");
      }

      const authorization = await authorize?.(state, decision.action, {
        task,
        step,
        history,
        observation,
        rationale: decision.rationale,
      });

      if (authorization?.status === "rejected") {
        const result = authorization.message || "操作未获批准";
        history.push({
          step,
          rationale: decision.rationale,
          action: decision.action,
          result,
          url: observation?.url,
          title: observation?.title,
        });

        onEvent?.({
          type: "step",
          step,
          stage: "result",
          result,
        });
        continue;
      }

      onEvent?.({
        type: "step",
        step,
        stage: "action",
        rationale: decision.rationale,
        action: decision.action,
        usage: decision.usage || null,
      });

      let result;
      try {
        result = await execute(state, decision.action, {
          task,
          step,
          history,
          observation,
          authorization,
        });
      } catch (execErr) {
        result = `执行失败: ${execErr.message}`;
        log.error(`[Runtime] step ${step} execute error: ${execErr.message}`);
      }

      if (isCancelled?.()) {
        throw new Error("Agent 已取消");
      }

      history.push({
        step,
        rationale: decision.rationale,
        action: decision.action,
        result,
        url: observation?.url,
        title: observation?.title,
      });


  // Self-correction: ask LLM to review the result
  if (review && decision.action.type !== "finish" && result && !String(result).startsWith("执行失败")) {
    let retryCount = 0;
    let needsRetry = false;
    do {
      needsRetry = false;
      const reviewResult = await review({ task, step, history, observation, result, state });
      if (reviewResult?.needs_retry === true && retryCount < MAX_RETRIES_PER_STEP) {
        log.info(`[Runtime] step ${step} self-correct: ${reviewResult.reason}`);
        history.push({ step, type: "review", result: reviewResult.reason });
        needsRetry = true;
        retryCount++;
        const newDecision = await decide({ task, step, history, observation, state });
        decision = newDecision;
      }
    } while (needsRetry);
  }
      if (decision.action.type !== "finish") {
        onEvent?.({
          type: "step",
          step,
          stage: "result",
          result,
        });
      }

      onCheckpoint?.(history, step);

      if (decision.action.type === "finish") {
        finalAnswer = decision.action.answer || result;
        break;
      }
    }

    if (!finalAnswer) {
      finalAnswer = "已达到最大执行步数，任务未完全完成。";
    }

    return {
      answer: finalAnswer,
      steps: history,
    };
  } finally {
    await cleanup?.(state);
  }
}
