import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  saveHealthySnapshot,
  loadLatestHealthySnapshot,
  listSessionCheckpoints,
  KEEP_HEALTHY,
} from '../agent/core/checkpoint.ts';
import { runAgentRuntime } from '../agent/core/runtime.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import type { AgentStep } from '../agent/core/contracts.ts';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-checkpoint-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeHistory(steps: number[]): AgentStep[] {
  return steps.map(s => ({
    step: s,
    rationale: `step ${s} rationale`,
    action: { tool: 'browser', type: 'click', elementId: `el-${s}` },
    result: `step ${s} result`,
  }));
}

// ─── session-checkpoint module tests ───

describe('saveHealthySnapshot + loadLatestHealthySnapshot', () => {
  it('writes snapshot to disk and loads it back', async () => {
    const runId = 'run_test1';
    const history = makeHistory([1, 2]);
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history, state: null, result: 'ok' });

    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 2);
    expect(cp).not.toBeNull();
    expect(cp.step).toBe(2);
    expect(cp.type).toBe('healthy');
    expect(cp.history).toHaveLength(2);
    expect(cp.history[0].step).toBe(1);
    expect(cp.history[1].step).toBe(2);
  });

  it('loads the latest snapshot <= upToStep', async () => {
    const runId = 'run_test2';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: makeHistory([1, 2]), state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 4, history: makeHistory([1, 2, 3, 4]), state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 6, history: makeHistory([1, 2, 3, 4, 5, 6]), state: null, result: 'ok' });

    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 5);
    expect(cp).not.toBeNull();
    expect(cp.step).toBe(4);

    const cp6 = await loadLatestHealthySnapshot(tmpDir, runId, 6);
    expect(cp6.step).toBe(6);
  });

  it('returns null when no snapshot exists', async () => {
    const cp = await loadLatestHealthySnapshot(tmpDir, 'run_nonexist', 5);
    expect(cp).toBeNull();
  });
});

describe('snapshot pruning', () => {
  it('keeps only KEEP_HEALTHY most recent snapshots', async () => {
    const runId = 'run_prune';
    // Save more than KEEP_HEALTHY snapshots
    for (let s = 1; s <= 40; s++) {
      await saveHealthySnapshot({ dir: tmpDir, runId, step: s, history: makeHistory([s]), state: null, result: 'ok' });
    }

    const cpDir = path.join(tmpDir, 'session-checkpoints', runId);
    const files = await fs.readdir(cpDir);
    const healthyFiles = files.filter(f => f.startsWith('session-healthy-') && f.endsWith('.json'));
    expect(healthyFiles).toHaveLength(KEEP_HEALTHY);

    const steps = healthyFiles.map(f => {
      const m = f.match(/session-healthy-(\d+)\.json$/);
      return m ? parseInt(m[1]) : 0;
    }).sort((a, b) => a - b);
    // Should keep the latest KEEP_HEALTHY steps
    expect(steps[0]).toBe(40 - KEEP_HEALTHY + 1);
    expect(steps[steps.length - 1]).toBe(40);
  });
});

describe('sanitizeState', () => {
  it('removes sensitive fields from snapshot state', async () => {
    const runId = 'run_sanitize';
    const state = {
      chromium: '/path/to/chrome',
      browserCandidatePaths: ['/a', '/b'],
      onEvent: () => {},
      browserSession: { page: {} },
      observeDesktop: true,
      customField: 'keep this',
    };
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: [], state, result: 'ok' });

    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 2);
    expect(cp.state.chromium).toBeUndefined();
    expect(cp.state.browserCandidatePaths).toBeUndefined();
    expect(cp.state.onEvent).toBeUndefined();
    expect(cp.state.browserSession).toBeUndefined();
    expect(cp.state.observeDesktop).toBeUndefined();
    expect(cp.state.browserSessionActive).toBe(true);
    expect(cp.state.customField).toBe('keep this');
  });
});

describe('listSessionCheckpoints', () => {
  it('lists healthy checkpoints sorted by step', async () => {
    const runId = 'run_list';
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 2, history: [], state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 4, history: [], state: null, result: 'ok' });
    await saveHealthySnapshot({ dir: tmpDir, runId, step: 6, history: [], state: null, result: 'ok' });

    const list = await listSessionCheckpoints(tmpDir, runId);
    expect(list).toHaveLength(3);
    expect(list[0].step).toBe(2);
    expect(list[0].type).toBe('healthy');
    expect(list[1].step).toBe(4);
    expect(list[2].step).toBe(6);
  });
});

// ─── runtime integration tests ───

function noop() {}
const initialize = () => ({});
const observe = () => ({});
const approve = () => ({ status: 'approved' as const });
const decision = (action: Record<string, unknown>, rationale = '') =>
  normalizeDesktopAgentDecision({ action, rationale });
const events = () => {
  const log = [];
  return { log, onEvent: e => log.push(e) };
};

describe('runtime: session checkpoint integration', () => {
  it('rejects a finish answer that only echoes the task and retries the next step', async () => {
    const cancelSignal = new AbortController().signal;
    const execute = vi.fn((_state, action) => (
      action.type === 'finish' ? action.answer : 'verified search result'
    ));

    const result = await runAgentRuntime({
      task: 'kimi为什么从英伟达模型nim里拿掉了',
      maxSteps: 3,
      onEvent: noop,
      cancelSignal,
      initialize,
      observe,
      decide: ({ step }) => {
        if (step === 1) return decision({ type: 'finish', answer: 'kimi为什么从英伟达模型nim里拿掉了' });
        if (step === 2) return decision({ tool: 'search', type: 'web_search', query: 'Kimi NVIDIA NIM model removed' });
        return decision({ type: 'finish', answer: 'Kimi 的 NIM 上架状态需要以 NVIDIA 当前模型目录为准。' });
      },
      authorize: approve,
      execute,
      cleanup: noop,
    });

    expect(result.steps[0]).toMatchObject({
      action: { type: 'finish' },
      resultStatus: 'failed',
      resultError: 'finish answer echoed task',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe('Kimi 的 NIM 上架状态需要以 NVIDIA 当前模型目录为准。');
  });

  it('records action target URL in history instead of the previous observation URL', async () => {
    const cancelSignal = new AbortController().signal;
    const result = await runAgentRuntime({
      task: 'fetch target page',
      maxSteps: 2,
      onEvent: noop,
      cancelSignal,
      initialize,
      observe: () => ({ url: 'https://previous.example/', title: 'Previous' }),
      decide: ({ step }) => step === 1
        ? decision({ tool: 'browser', type: 'http_fetch', url: 'https://target.example/page' }, 'fetch target')
        : decision({ type: 'finish', answer: 'done' }, 'done'),
      authorize: approve,
      execute: () => 'target content',
      cleanup: noop,
    });

    expect(result.steps[0].url).toBe('https://target.example/page');
  });

  it('emits structured result status for execution failures', async () => {
    const cancelSignal = new AbortController().signal;
    const { log: evtLog, onEvent } = events();

    const result = await runAgentRuntime({
      task: 'run command',
      maxSteps: 2,
      onEvent,
      cancelSignal,
      initialize,
      observe,
      decide: ({ step }) => step === 1
        ? decision({ tool: 'terminal', type: 'run_safe', command: 'bad' }, 'run')
        : decision({ type: 'finish', answer: 'done' }, 'finish'),
      authorize: approve,
      execute: (_state, action) => {
        if (action.type === 'finish') return action.answer;
        throw new Error('exit code 1');
      },
      cleanup: noop,
    });

    const resultEvent = evtLog.find(e => e.type === 'step' && e.stage === 'result');
    expect(resultEvent).toMatchObject({
      resultStatus: 'failed',
      resultError: 'exit code 1',
    });
    expect(result.steps[0]).toMatchObject({
      resultStatus: 'failed',
      resultError: 'exit code 1',
    });
  });

  it('stops before repeatedly executing the same action with the same result', async () => {
    const cancelSignal = new AbortController().signal;
    const { log: evtLog, onEvent } = events();
    let executeCalls = 0;

    const result = await runAgentRuntime({
      task: 'inspect a file',
      maxSteps: 6,
      onEvent,
      cancelSignal,
      initialize,
      observe,
      decide: () => decision({ tool: 'fs', type: 'read_file', path: 'word/document.xml', maxBytes: 12000 }, 'read template'),
      authorize: approve,
      execute: () => {
        executeCalls += 1;
        return 'same file content';
      },
      cleanup: noop,
    });

    expect(executeCalls).toBe(2);
    expect(result.steps).toHaveLength(2);
    expect(result.answer).toContain('重复执行同一动作');
    expect(evtLog.some(e => e.type === 'notification' && e.level === 'warning')).toBe(true);
  });

  it('stops before retrying the same readonly action after a structured failure', async () => {
    const cancelSignal = new AbortController().signal;
    const { log: evtLog, onEvent } = events();
    let executeCalls = 0;

    const result = await runAgentRuntime({
      task: 'search market data',
      maxSteps: 4,
      onEvent,
      cancelSignal,
      initialize,
      observe,
      decide: () => decision({ tool: 'search', type: 'web_search', query: '2026年7月3日 A股收盘行情' }, 'search'),
      authorize: approve,
      execute: () => {
        executeCalls += 1;
        return {
          result: 'web_search 失败：DuckDuckGo 触发反爬验证。',
          resultStatus: 'failed',
          resultError: 'DuckDuckGo 触发反爬验证',
        };
      },
      cleanup: noop,
    });

    expect(executeCalls).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(result.answer).toContain('刚失败的同一动作');
    expect(evtLog.some(e => e.type === 'notification' && e.level === 'warning')).toBe(true);
  });

  it('stops before repeatedly clicking the same browser element', async () => {
    const cancelSignal = new AbortController().signal;
    const { log: evtLog, onEvent } = events();
    let executeCalls = 0;

    const result = await runAgentRuntime({
      task: '搜索网页内容',
      maxSteps: 8,
      onEvent,
      cancelSignal,
      initialize,
      observe,
      decide: () => decision({ tool: 'browser', type: 'click', elementId: '3' }, '点击搜索按钮'),
      authorize: approve,
      execute: () => {
        executeCalls += 1;
        return '已点击元素 3';
      },
      cleanup: noop,
    });

    expect(executeCalls).toBe(2);
    expect(result.steps).toHaveLength(2);
    expect(result.answer).toContain('重复执行同一动作');
    expect(result.answer).toContain('browser.click 3');
    expect(evtLog.some(e => e.type === 'notification' && e.level === 'warning')).toBe(true);
  });

  it('replaces repeated no-progress scrolling with page-content extraction', async () => {
    const cancelSignal = new AbortController().signal;
    const { log: evtLog, onEvent } = events();
    const executedTypes: string[] = [];
    const decide = vi.fn()
      .mockReturnValueOnce(decision({ tool: 'browser', type: 'scroll', direction: 'down', amount: 10 }, 'scroll'))
      .mockReturnValueOnce(decision({ tool: 'browser', type: 'scroll', direction: 'down', amount: 10 }, 'scroll'))
      .mockReturnValueOnce(decision({ tool: 'browser', type: 'scroll', direction: 'down', amount: 10 }, 'scroll'))
      .mockReturnValueOnce(decision({ tool: 'core', type: 'finish', answer: '已提取页面内容' }, 'finish'));

    const result = await runAgentRuntime({
      task: '读取页面',
      maxSteps: 4,
      onEvent,
      cancelSignal,
      initialize,
      observe,
      decide,
      authorize: approve,
      execute: (_state, action) => {
        executedTypes.push(action.type);
        return action.type === 'get_page_content'
          ? '页面完整正文'
          : '已滚动，但页面内容未变化';
      },
      cleanup: noop,
    });

    expect(executedTypes).toEqual(['scroll', 'scroll', 'get_page_content', 'finish']);
    expect(result.answer).toContain('已提取页面内容');
    expect(evtLog.some(e => e.type === 'notification' && String(e.message).includes('自动改用 get_page_content'))).toBe(true);
  });

  it('requests a finish-only summary after the last tool step', async () => {
    const cancelSignal = new AbortController().signal;
    const decide = vi.fn((context: any) => context.finalOnly
      ? decision({ tool: 'core', type: 'finish', answer: '根据官网正文：在职60%，退休80%。' }, 'summarize')
      : decision({ tool: 'browser', type: 'get_page_content' }, 'fetch content'));
    let executeCalls = 0;

    const result = await runAgentRuntime({
      task: '总结医保信息',
      maxSteps: 1,
      cancelSignal,
      initialize,
      observe,
      decide,
      authorize: approve,
      execute: () => {
        executeCalls += 1;
        return '北京市医保局正文：在职60%，退休80%。';
      },
      cleanup: noop,
    });

    expect(executeCalls).toBe(1);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[1][0]).toEqual(expect.objectContaining({ finalOnly: true, step: 2 }));
    expect(result.answer).toContain('根据官网正文：在职60%，退休80%。');
    expect(result.answer).not.toContain('已达到最大执行步数');
  });

  it('saves snapshots at interval steps', async () => {
    const runId = 'run_rt2';
    const runRecord = { runId, pendingRollback: null };
    const { log: evtLog, onEvent } = events();
    const cancelSignal = new AbortController().signal;

    let stepCount = 0;
    await runAgentRuntime({
      task: 'test',
      maxSteps: 7,
      onEvent,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord,
      initialize,
      observe,
      decide: () => {
        stepCount++;
        if (stepCount >= 7) {
          return decision({ type: 'finish', answer: 'all done' }, 'enough');
        }
        return decision({ type: 'click', elementId: `btn-${stepCount}` }, 'go');
      },
      authorize: approve,
      execute: () => 'executed',
      cleanup: noop,
    });

    // HEALTH_CHECKPOINT_INTERVAL = 1, every step gets a snapshot (including the finish step)
    const cpEvents = evtLog.filter(e => e.type === 'session_checkpoint');
    expect(cpEvents.map(e => e.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Snapshot save is fire-and-forget — wait for disk writes to complete
    await new Promise(r => setTimeout(r, 200));
    const cp = await loadLatestHealthySnapshot(tmpDir, runId, 6);
    expect(cp).not.toBeNull();
    expect(cp.history.length).toBeGreaterThanOrEqual(5);
  });

  it('delegates session snapshot persistence to a callback with serializable state', async () => {
    const runId = 'run_rt_worker_snapshot';
    const cancelSignal = new AbortController().signal;
    const snapshots: any[] = [];

    await runAgentRuntime({
      task: 'test',
      maxSteps: 1,
      onEvent: noop,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord: { runId, pendingRollback: null },
      saveSessionSnapshot: snapshot => snapshots.push(snapshot),
      initialize: () => ({
        runId,
        onEvent: noop,
        browserSession: { view: { navigate: async () => {}, circular: true } },
        observeDesktop: true,
        keep: 'ok',
      }),
      observe,
      decide: () => decision({ type: 'finish', answer: 'done' }, 'ok'),
      authorize: approve,
      execute: () => 'done',
      cleanup: noop,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].state.browserSession).toBeUndefined();
    expect(snapshots[0].state.observeDesktop).toBeUndefined();
    expect(snapshots[0].state.browserSessionActive).toBe(true);
    expect(snapshots[0].state.keep).toBe('ok');
  });

  it('manual rollback restores snapshot history and continues', { timeout: 15000 }, async () => {
    const runId = 'run_rt3';
    const cancelSignal = new AbortController().signal;

    // First run: create checkpoints up to step 6
    let stepCount = 0;
    await runAgentRuntime({
      task: 'test',
      maxSteps: 7,
      onEvent: noop,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord: { runId, pendingRollback: null },
      initialize,
      observe,
      decide: () => {
        stepCount++;
        if (stepCount >= 7) {
          return decision({ type: 'finish', answer: 'done' }, 'enough');
        }
        return decision({ type: 'click', elementId: `btn-${stepCount}` }, 'go');
      },
      authorize: approve,
      execute: () => 'executed',
      cleanup: noop,
    });

    // Snapshot save is fire-and-forget — wait for IO then poll
    await new Promise(r => setTimeout(r, 1000));
    let snap2 = null;
    for (let i = 0; i < 50; i++) {
      snap2 = await loadLatestHealthySnapshot(tmpDir, runId, 2);
      if (snap2 && snap2.step === 2) break;
      snap2 = null;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(snap2).not.toBeNull();
    expect(snap2.step).toBe(2);

    // Second run: rollback to step 2
    const runRecord2: any = { runId, pendingRollback: 2 };
    const { log: evtLog2, onEvent: onEvent2 } = events();
    stepCount = 0;

    const result = await runAgentRuntime({
      task: 'test',
      maxSteps: 8,
      onEvent: onEvent2,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord: runRecord2,
      initialStep: 1,
      initialHistory: makeHistory([1, 2, 3, 4]),
      initialize,
      observe,
      decide: () => {
        stepCount++;
        if (stepCount >= 3) {
          return decision({ type: 'finish', answer: 'rolled back' }, 'done');
        }
        return decision({ type: 'click', elementId: 'btn' }, 'retry');
      },
      authorize: approve,
      execute: () => 'executed',
      cleanup: noop,
    });

    const rollbackEvent = evtLog2.find(e => e.type === 'rollback');
    expect(rollbackEvent).toBeDefined();
    expect(rollbackEvent.targetStep).toBe(2);
    expect(runRecord2.pendingRollback).toBeNull();
    expect(runRecord2.rolledBack).toBe(true);
    expect(result.answer).toBe('rolled back');
  });

  it('rollback to nonexistent snapshot clears pendingRollback and continues', async () => {
    const runId = 'run_rt4';
    const runRecord = { runId, pendingRollback: 99 };
    const { log: evtLog, onEvent } = events();
    const cancelSignal = new AbortController().signal;

    const result = await runAgentRuntime({
      task: 'test',
      maxSteps: 101,
      onEvent,
      cancelSignal,
      sessionCheckpointDir: tmpDir,
      runRecord,
      initialize,
      observe,
      decide: () => decision({ type: 'finish', answer: 'done' }, 'ok'),
      authorize: approve,
      execute: noop,
      cleanup: noop,
    });

    expect(runRecord.pendingRollback).toBeNull();
    // 即使无快照，回滚仍会执行（清空 history，从 targetStep 重新开始）
    expect(evtLog.some(e => e.type === 'rollback')).toBe(true);
    expect(evtLog.find(e => e.type === 'rollback').targetStep).toBe(99);
    expect(result.answer).toBe('done');
    // Wait for fire-and-forget snapshot writes to complete
    await new Promise(r => setTimeout(r, 200));
  });
});
