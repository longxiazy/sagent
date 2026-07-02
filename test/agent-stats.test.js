import { describe, expect, it } from 'vitest';
import {
  buildAgentMetaFromSession,
  buildAgentStats,
  normalizeAgentMeta,
} from '../client/src/utils/agent-stats.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi, 0).getTime();

describe('agent stats metadata', () => {
  it('从 trace 和 session 消息重建一次完成运行的 agentMeta', () => {
    const startedAt = at(2026, 5, 30, 9, 0);
    const trace = [
      { type: 'run_meta', runId: 'run_1', startedAt, task: '分析日志错误' },
      { type: 'model_plan', stage: 'start', step: 1, strategy: 'vote', models: ['m1', 'm2'], timestamp: startedAt + 100 },
      { type: 'model_plan', stage: 'winner', step: 1, model: 'm1', usage: { prompt_tokens: 100, completion_tokens: 25 }, timestamp: startedAt + 600 },
      { type: 'step', stage: 'result', step: 1, timestamp: startedAt + 1200 },
      { type: 'done', runId: 'run_1', timestamp: startedAt + 3000, meta: { elapsed_ms: 3000, step_count: 1, models_used: ['m1'], status: 'done' } },
    ];
    const session = {
      id: 's1',
      agentRunId: 'run_1',
      messages: [
        { role: 'user', content: '分析日志错误', ts: startedAt },
        { role: 'assistant', content: '完成', ts: startedAt + 3100 },
      ],
    };

    const meta = buildAgentMetaFromSession(session, trace);

    expect(meta).toMatchObject({
      task: '分析日志错误',
      startedAt,
      elapsedMs: 3000,
      totalTokens: 125,
      stepCount: 1,
      models: ['m1', 'm2'],
      strategy: 'vote',
      status: 'done',
      runId: 'run_1',
    });
  });

  it('规范化持久化 meta，过滤坏模型并保留核心字段', () => {
    const meta = normalizeAgentMeta({
      task: '  代码审查  ',
      startedAt: 100,
      endedAt: 200,
      elapsedMs: 99.7,
      totalTokens: 1200.2,
      stepCount: 4.2,
      models: ['m1', '', 'm1', 'm2'],
      strategy: 'race',
      status: 'done_degraded',
      runId: 'run_2',
    });

    expect(meta).toEqual({
      task: '代码审查',
      startedAt: 100,
      endedAt: 200,
      elapsedMs: 99.7,
      totalTokens: 1200,
      stepCount: 4,
      models: ['m1', 'm2'],
      strategy: 'race',
      status: 'done_degraded',
      runId: 'run_2',
    });
  });
});

describe('buildAgentStats', () => {
  it('按今天聚合运行次数、耗时、token 和模型数', () => {
    const now = at(2026, 5, 30, 12, 0);
    const today = at(2026, 5, 30, 9, 0);
    const yesterday = at(2026, 5, 29, 9, 0);
    const sessions = [
      {
        id: 'today',
        agentMeta: {
          task: '分析 API',
          startedAt: today,
          endedAt: today + 2000,
          elapsedMs: 2000,
          totalTokens: 1500,
          stepCount: 2,
          models: ['m1', 'm2'],
          strategy: 'race',
          status: 'done',
          runId: 'r_today',
        },
      },
      {
        id: 'yesterday',
        agentMeta: {
          task: '审查 PR',
          startedAt: yesterday,
          endedAt: yesterday + 1000,
          elapsedMs: 1000,
          totalTokens: 500,
          stepCount: 1,
          models: ['m2'],
          strategy: 'race',
          status: 'done',
          runId: 'r_yesterday',
        },
      },
    ];

    const stats = buildAgentStats(sessions, { now });

    expect(stats.totalRuns).toBe(2);
    expect(stats.todayRuns).toBe(1);
    expect(stats.todayElapsedMs).toBe(2000);
    expect(stats.todayTokens).toBe(1500);
    expect(stats.todayModelCount).toBe(2);
    expect(stats.totalTokens).toBe(2000);
    expect(stats.recentRuns.map(item => item.sessionId)).toEqual(['today', 'yesterday']);
    expect(stats.dailyData.at(-1)).toMatchObject({ date: '2026-06-30', tokens: 1500, runs: 1 });
  });

  it('统计同一会话内的多次 agentRuns，并按 runId 去重当前 run', () => {
    const now = at(2026, 5, 30, 12, 0);
    const first = at(2026, 5, 30, 9, 0);
    const second = at(2026, 5, 30, 10, 0);
    const sessions = [
      {
        id: 'multi-run-session',
        agentRunId: 'run_second',
        agentMeta: {
          task: '第二次问题',
          startedAt: second,
          endedAt: second + 2000,
          elapsedMs: 2000,
          totalTokens: 700,
          stepCount: 2,
          models: ['m2'],
          strategy: 'race',
          status: 'done',
          runId: 'run_second',
        },
        agentRuns: [
          {
            runId: 'run_second',
            meta: {
              task: '第二次问题',
              startedAt: second,
              endedAt: second + 2000,
              elapsedMs: 2000,
              totalTokens: 700,
              stepCount: 2,
              models: ['m2'],
              strategy: 'race',
              status: 'done',
              runId: 'run_second',
            },
          },
          {
            runId: 'run_first',
            meta: {
              task: '第一次问题',
              startedAt: first,
              endedAt: first + 1000,
              elapsedMs: 1000,
              totalTokens: 300,
              stepCount: 1,
              models: ['m1'],
              strategy: 'race',
              status: 'done',
              runId: 'run_first',
            },
          },
        ],
      },
    ];

    const stats = buildAgentStats(sessions, { now });

    expect(stats.totalRuns).toBe(2);
    expect(stats.todayRuns).toBe(2);
    expect(stats.todayTokens).toBe(1000);
    expect(stats.recentRuns.map(item => item.runId)).toEqual(['run_second', 'run_first']);
  });
});
