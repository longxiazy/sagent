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
 *
 * v2 增强（2026-04-30）：
 *   - 会话级健康检查点（session-checkpoint.js 集成）
 *   - decide 连续失败自动回滚到上一个健康快照
 *   - 前端可触发手动回滚
 */

import { log } from "../../helpers/logger.js";
import {
  saveHealthySnapshot,
  saveFailedSnapshot,
  loadLatestHealthySnapshot,
  HEALTH_CHECKPOINT_INTERVAL,
} from "./session-checkpoint.js";

const MAX_HISTORY_STEPS = 64;
const MAX_DECIDE_ERRORS = 3; // 连续 decide 失败多少次后自动回滚

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

/**
 * 检查外部回滚请求（由前端通过 /api/agent/rollback 设置）
 */
function shouldRollback(runRecord) {
  return runRecord?.pendingRollback != null;
}

export async function runAgentRuntime({
  task,
  maxSteps = 8,
  onEvent,
  cancelSignal,
  initialize,
  observe,
  decide,
  authorize,
  execute,
  cleanup,
  shouldObserve,
  initialStep = 1,
  initialHistory = [],
  onCheckpoint = null,
  // v2: 会话检查点 & 自动回滚
  sessionCheckpointDir = null,
  runRecord = null,
}) {
  const history = initialHistory;
  let finalAnswer = "";
  const state = await initialize?.({ task, onEvent });
  let decideErrorCount = 0;

  const cancelled = () => cancelSignal?.aborted;

  try {
    for (let step = initialStep; step <= maxSteps; step += 1) {
      if (cancelled()) {
        throw new Error("Agent 已取消");
      }

      // ---- 检查外部回滚请求 ----
      if (runRecord && shouldRollback(runRecord)) {
        const targetStep = runRecord.pendingRollback;
        log.info(`[Runtime] 执行回滚到第 ${targetStep} 步`);
        const snapshot = await loadLatestHealthySnapshot(sessionCheckpointDir, runRecord.runId, targetStep);
        if (snapshot) {
          // 清空 history 到目标步数
          history.length = 0;
          for (const h of snapshot.history) {
            history.push({ ...h });
          }
          step = targetStep;
          decideErrorCount = 0;
          runRecord.pendingRollback = null;
          runRecord.rolledBack = true;

          onEvent?.({
            type: "rollback",
            targetStep,
            message: `已回滚到第 ${targetStep} 步`,
          });
          continue;
        } else {
          log.warn(`[Runtime] 回滚失败: 未找到第 ${targetStep} 步的健康快照`);
          runRecord.pendingRollback = null;
        }
      }

      // ---- 观察 ----
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

      // ---- 决策（带自动回滚保护） ----
      let decision;
      try {
        decision = await decide({
          task,
          step,
          history: compactHistory,
          observation,
          state,
        });
        decideErrorCount = 0; // 成功则重置错误计数
      } catch (decErr) {
        decideErrorCount++;
        log.error(`[Runtime] step ${step} decide 失败 (${decideErrorCount}/${MAX_DECIDE_ERRORS}): ${decErr.message}`);

        if (decideErrorCount >= MAX_DECIDE_ERRORS && sessionCheckpointDir && runRecord) {
          // 自动回滚到上一个健康快照
          const snapshot = await loadLatestHealthySnapshot(sessionCheckpointDir, runRecord.runId, step - 1);
          if (snapshot) {
            log.info(`[Runtime] 连续 ${MAX_DECIDE_ERRORS} 次 decide 失败，自动回滚到第 ${snapshot.step} 步`);
            history.length = 0;
            for (const h of snapshot.history) {
              history.push({ ...h });
            }
            step = snapshot.step;
            decideErrorCount = 0;

            await saveFailedSnapshot({
              dir: sessionCheckpointDir,
              runId: runRecord.runId,
              step,
              history,
              error: new Error(`连续 ${MAX_DECIDE_ERRORS} 次 decide 失败，自动回滚`),
              state,
            });

            onEvent?.({
              type: "rollback",
              targetStep: snapshot.step,
              message: `连续 ${MAX_DECIDE_ERRORS} 次决策失败，自动回滚到第 ${snapshot.step} 步`,
              auto: true,
            });
            continue;
          }
        }
        throw decErr; // 未达到阈值或无快照，继续抛异常
      }

      if (cancelled()) {
        throw new Error("Agent 已取消");
      }

      // ---- 授权 ----
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

      // ---- 执行 ----
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

      if (cancelled()) {
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

      if (decision.action.type !== "finish") {
        onEvent?.({
          type: "step",
          step,
          stage: "result",
          result,
        });
      }

      // ---- 原有 checkpoint（step 级） ----
      onCheckpoint?.(history, step);

      // ---- 会话级健康快照 ----
      if (sessionCheckpointDir && runRecord && step % HEALTH_CHECKPOINT_INTERVAL === 0) {
        const runId = runRecord.runId;
        saveHealthySnapshot({
          dir: sessionCheckpointDir,
          runId,
          step,
          history,
          state,
          result,
          usage: decision.usage,
        }).catch(err => log.error(`[Runtime] 健康快照保存失败: ${err.message}`));
        onEvent?.({
          type: "session_checkpoint",
          step,
          message: `已创建第 ${step} 步健康快照`,
        });
      }

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