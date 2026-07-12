/**
 * Spawn Tool — 并行分发子 Agent 任务
 *
 * 允许主 Agent 将独立子任务并行分发给子 Agent，最后聚合结果。
 * 与 PR #24 的 HTTP 自调用方案不同，本实现通过注入的 runSubAgent 函数在进程内执行子任务。
 *
 * 使用场景:
 *   - 并行分析多个文件
 *   - 同时爬取多个页面
 *   - 批量处理独立任务
 */

import { log } from '../../../helpers/logger.ts';
import { createAbortScope, throwIfAborted } from '../../core/abort.ts';
import type { AgentStep, ResultQuality } from '../../core/contracts.ts';

const SUB_AGENT_TIMEOUT_MS = 120_000; // 2 minutes per sub-agent

export async function executeSpawnAction(
  action: { type: string; tasks: string[] },
  context: {
    runSubAgent?: (task: string, subIndex: number, signal: AbortSignal, deadline: number | null) => Promise<{ answer: string; steps: AgentStep[]; quality?: ResultQuality }>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
) {
  if (!context.runSubAgent) {
    return '错误: spawn 工具在当前上下文中不可用（可能是子 Agent 尝试嵌套调用）';
  }

  const tasks = Array.isArray(action.tasks) ? action.tasks : [];
  if (tasks.length === 0) {
    throw new Error('spawn.tasks 至少需要一个非空任务字符串，例如：["搜索并总结相关官方资料"]');
  }
  if (tasks.length > 5) {
    throw new Error('spawn 最多支持 5 个并行任务');
  }

  log.info(`[Spawn] 启动 ${tasks.length} 个并行子任务`);
  const timeoutMs = Number.isFinite(context.timeoutMs) && Number(context.timeoutMs) > 0
    ? Number(context.timeoutMs)
    : SUB_AGENT_TIMEOUT_MS;

  // 并行执行所有子任务，每个带超时保护
  const results = await Promise.allSettled(
    tasks.map(async (task, i) => {
      const timeoutMessage = `子 Agent 超时 (${Math.round(timeoutMs / 1000)}s)`;
      const scope = createAbortScope({ signals: [context.signal], timeoutMs, timeoutMessage });

      try {
        throwIfAborted(scope.signal);
        const result = await context.runSubAgent(task, i, scope.signal, scope.deadline);
        return { index: i, success: true, task, result };
      } catch (err: unknown) {
        const error = scope.signal.aborted && scope.signal.reason instanceof Error
          ? scope.signal.reason.message
          : err instanceof Error ? err.message : String(err);
        return { index: i, success: false, task, error };
      } finally {
        scope.cleanup();
      }
    })
  );

  // 格式化结果
  const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  const lines = [`[Spawn] 完成 ${successCount}/${tasks.length} 个子任务\n`];

  for (const r of results) {
    if (r.status === 'rejected') {
      lines.push(`❌ 子任务失败: ${r.reason?.message || r.reason}`);
      continue;
    }
    const v = r.value;
    if (v.success) {
      const answer = v.result.answer || '（无返回结果）';
      const truncated = answer.length > 1000 ? answer.slice(0, 1000) + '…' : answer;
      const stepCount = v.result.steps?.length || 0;
      const quality = v.result.quality?.status || 'done';
      lines.push(`✅ 子任务 ${v.index + 1}: ${v.task.slice(0, 80)}`);
      lines.push(`   步数: ${stepCount}, 质量: ${quality}`);
      lines.push(`   结果: ${truncated}\n`);
    } else {
      lines.push(`❌ 子任务 ${v.index + 1}: ${v.task.slice(0, 80)}`);
      lines.push(`   错误: ${v.error}\n`);
    }
  }

  return lines.join('\n');
}
