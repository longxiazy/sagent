/**
 * Spawn Tool — 并行分发子 Agent 任务
 *
 * 灵感来源: Cursor 8 Agent 并行协作、Manus 多 Agent 系统
 * 允许 Agent 将独立子任务并行分发给子 Agent，最后聚合结果。
 *
 * 使用场景:
 * { tool: 'spawn', type: 'parallel', tasks: [{task: '分析A', model: 'claude'}, {task: '分析B', model: 'minimaxai/minimax-m2.7'}] }
 */

import { log } from '../../helpers/logger.js';

// 简单的子 Agent 执行器（不依赖完整 server，用 HTTP 调用主服务）
export async function executeSpawnAction(action, { apiBaseUrl = 'http://localhost:3000' } = {}) {
  if (action.type === 'parallel') {
    const tasks = Array.isArray(action.tasks) ? action.tasks : [];
    if (tasks.length === 0) {
      throw new Error('spawn.parallel 缺少 tasks 数组');
    }
    if (tasks.length > 5) {
      throw new Error('spawn.parallel 最多支持 5 个并行任务');
    }

    log.info(`[Spawn] 启动 ${tasks.length} 个并行子任务`);

    // 并行执行所有子任务
    const results = await Promise.allSettled(
      tasks.map(async (t, i) => {
        const subTask = typeof t === 'string' ? t : t.task;
        const subModel = (typeof t === 'object' && t.model) || null;

        try {
          // 通过 Agent API 启动子任务
          const body = { task: subTask };
          if (subModel) body.model = subModel;
          // 非阻塞调用，返回 taskId 用于后续查询
          const res = await fetch(`${apiBaseUrl}/api/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, headless: true }),
            signal: AbortSignal.timeout(60000),
          });
          if (!res.ok) throw new Error(`子任务 ${i} 失败: ${res.status}`);
          const data = await res.json();
          return { index: i, success: true, taskId: data.runId, task: subTask, result: data };
        } catch (err) {
          return { index: i, success: false, task: subTask, error: err.message };
        }
      })
    );

    // 格式化结果
    const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const lines = [`[Spawn] 完成 ${successCount}/${tasks.length} 个子任务`];

    for (const r of results) {
      if (r.status === 'rejected') {
        lines.push(`❌ 子任务失败: ${r.reason?.message}`);
        continue;
      }
      const v = r.value;
      if (v.success) {
        lines.push(`✅ 子任务${v.index}: ${v.task} → runId=${v.taskId}`);
      } else {
        lines.push(`❌ 子任务${v.index}: ${v.task} → ${v.error}`);
      }
    }

    return lines.join('\n');
  }

  if (action.type === 'delegate') {
    // 单个任务委托给专用 Agent
    const { task, agent: agentType = 'general' } = action;
    if (!task) throw new Error('spawn.delegate 缺少 task');

    return `[Spawn] 委托任务给 ${agentType} Agent: ${task.slice(0, 80)}${task.length > 80 ? '...' : ''}`;
  }

  throw new Error(`不支持的 spawn 类型: ${action.type}`);
}