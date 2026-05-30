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
 * 历史截断 / Progressive history truncation：
 *   compressHistory() 发给 LLM 前截断历史，防止上下文超限：
 *   - 保留最近 AGENT_MAX_HISTORY_STEPS（默认 20）步
 *   - 渐进截断 result：最近 3 步保留最多 MAX_RESULT_CHARS 字符，4-10 步 2500 字符，11+ 步 1000 字符
 *   - parallel_fetch 把 N 个页面拼成单步 result，按 URL 数放大该步预算（封顶 MAX_PARALLEL_RESULT_CHARS），避免多页结果被截到只剩第一页
 *   - 超出步数压缩为一行摘要
 *   - 可通过 .env 的 AGENT_MAX_HISTORY_STEPS / AGENT_MAX_RESULT_CHARS / AGENT_MAX_PARALLEL_RESULT_CHARS 配置
 *
 * 调用场景：
 *   - agent/desktop/agent.js 的 runDesktopAgent() 是唯一的调用方，
 *     注入所有具体实现后调用 runAgentRuntime({ ... })
 *
 * v2 增强：
 *   - 会话级健康检查点（session-checkpoint.js 集成）
 *   - 前端可触发手动回滚
 */

import { log } from "../../helpers/logger.js";
import {
  saveHealthySnapshot,
  loadLatestHealthySnapshot,
  HEALTH_CHECKPOINT_INTERVAL,
} from "./checkpoint.js";
import { assessResultQuality } from "./result-quality.ts";

const MAX_HISTORY_STEPS = Number(process.env.AGENT_MAX_HISTORY_STEPS || 20);
const MAX_RESULT_CHARS = Number(process.env.AGENT_MAX_RESULT_CHARS || 8000);
// parallel_fetch 把多个页面拼成单步 result，按 URL 数放大该步预算，封顶此值，避免被截到只剩第一页
const MAX_PARALLEL_RESULT_CHARS = Number(process.env.AGENT_MAX_PARALLEL_RESULT_CHARS || 32000);

function actionTargetUrl(action) {
  if (typeof action?.url === 'string' && action.url) return action.url;
  if (typeof action?.arguments?.url === 'string' && action.arguments.url) return action.arguments.url;
  return null;
}

function compressHistory(history, maxSteps = MAX_HISTORY_STEPS) {
  // Progressive truncation: recent steps keep more context, old steps get shorter results
  const truncateEntry = (h, remaining) => {
    // Last 3 steps: full (up to MAX_RESULT_CHARS)
    // Steps 4-10: 2500 chars
    // Steps 11+: 1000 chars
    let limit = remaining <= 3 ? MAX_RESULT_CHARS : remaining <= 10 ? 2500 : 1000;
    // parallel_fetch 把 N 个页面拼成单步 result，按 URL 数放大该步预算（封顶），
    // 否则多页抓取会被截到只剩第一页
    const urlCount = Array.isArray(h.action?.urls) ? h.action.urls.length : 0;
    if (h.action?.type === 'parallel_fetch' && urlCount > 1) {
      limit = Math.min(limit * urlCount, MAX_PARALLEL_RESULT_CHARS);
    }
    const str = h.result == null ? '' : String(h.result);
    if (str.length <= limit) return h;
    return { ...h, result: str.slice(0, limit) + '…[truncated]' };
  };

  if (history.length <= maxSteps) {
    return history.map((h, i) => truncateEntry(h, history.length - i));
  }
  const recent = history.slice(-maxSteps);
  const dropped = history.slice(0, -maxSteps);
  const summary = dropped
    .map(
      (h) =>
        `step ${h.step}: [${h.action?.type ?? "?"}] ${h.result ? `→ ${String(h.result).slice(0, 200)}` : ""}`,
    )
    .join(" | ");
  return [
    {
      step: 0,
      type: "summary",
      text: `历史摘要（共${dropped.length}步）: ${summary}`,
    },
    ...recent.map((h, i) => truncateEntry(h, recent.length - i)),
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
  shouldObserve = null,
  initialStep = 1,
  initialHistory = [],
  onCheckpoint = null,
  // v2: 会话检查点 & 手动回滚
  sessionCheckpointDir = null,
  runRecord = null,
}) {
  const history = initialHistory;
  let finalAnswer = "";
  const state = await initialize?.({ task, onEvent });

  const cancelled = () => cancelSignal?.aborted;

  try {
    for (let step = initialStep; step <= maxSteps; step += 1) {
      if (cancelled()) {
        throw new Error("Agent 已取消");
      }

      // ---- 检查外部回滚请求 ----
      if (runRecord && shouldRollback(runRecord) && !sessionCheckpointDir) {
        log.warn(`[Runtime] 回滚请求存在但 sessionCheckpointDir 未设置，跳过`);
        runRecord.pendingRollback = null;
      }
      if (sessionCheckpointDir && runRecord && shouldRollback(runRecord)) {
        const targetStep = runRecord.pendingRollback;
        log.info(`[Runtime] 执行回滚到第 ${targetStep} 步, dir=${sessionCheckpointDir}, runId=${runRecord.runId}`);
        const snapshot = await loadLatestHealthySnapshot(sessionCheckpointDir, runRecord.runId, targetStep - 1);
        if (snapshot) {
          history.length = 0;
          for (const h of snapshot.history) {
            history.push({ ...h });
          }
          // 从快照步骤继续（而非 targetStep - 1），避免跳步
          step = snapshot.step;
        } else {
          history.length = 0;
          // 无快照时从 targetStep - 1 开始（用户想回滚到 step N，从 N-1 后继续）
          step = targetStep - 1;
        }
        runRecord.pendingRollback = null;
        runRecord.rolledBack = true;

        onEvent?.({
          type: "rollback",
          targetStep,
          message: `已回滚到第 ${targetStep} 步`,
        });
        continue;
      }

      // ---- 观察 ----
      const lastAction =
        history.length > 0 ? history[history.length - 1].action : null;
      // 第一步 lastAction 为 null 时永远不跳过，避免初始观察缺失
      const skipObservation = shouldObserve && lastAction
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

      // ---- 决策前再次检查取消 ----
      if (cancelled()) {
        throw new Error("Agent 已取消");
      }

      // ---- 决策 ----
      const decision = await decide({
        task,
        step,
        history: compactHistory,
        observation,
        state,
      });

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
        const url = actionTargetUrl(decision.action) || observation?.url;
        history.push({
          step,
          rationale: decision.rationale,
          action: decision.action,
          result,
          url,
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
        url: actionTargetUrl(decision.action) || observation?.url,
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

      // ---- 会话级健康快照（后台写入，不阻塞） ----
      if (sessionCheckpointDir && runRecord && step % HEALTH_CHECKPOINT_INTERVAL === 0) {
        const runId = runRecord.runId;
        const snapData = {
          dir: sessionCheckpointDir,
          runId,
          step,
          history: history.map(h => ({ ...h })),
          state: { ...state },
          result,
          usage: decision.usage,
        };
        saveHealthySnapshot(snapData).catch(err => {
          log.error(`[Runtime] 健康快照保存失败: ${err.message}`);
        });
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

    const quality = assessResultQuality({ task, steps: history, answer: finalAnswer });

    // 降级时在 answer 前置警告条，避免用户把不完整结果误认为正常完成
    let answer = finalAnswer;
    if (quality.degraded) {
      const parts: string[] = [];
      if (Array.isArray(quality.failure_steps) && quality.failure_steps.length > 0) {
        parts.push(`${quality.failure_steps.length} 步执行失败（步骤 ${quality.failure_steps.join(', ')}）`);
      }
      if (quality.unverified) {
        parts.push('未获得权威/官方信息来源');
      }
      if ((quality as any).browse_intent_without_observation) {
        parts.push('任务要求基于网页内容但未取得任何有效页面观测，回答可能来自模型常识而非实地浏览');
      }
      if (parts.length > 0) {
        const warning = `> ⚠️ ${parts.join('；')}，返回结果可能不完整或存在偏差，请谨慎参考。\n\n`;
        answer = warning + answer;
      }
    }

    return {
      answer,
      steps: history,
      quality,
    };
  } finally {
    await cleanup?.(state);
  }
}
