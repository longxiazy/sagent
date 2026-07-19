import { describe, expect, it } from 'vitest';
import {
  buildStepPromptContext,
  extractRawOutputFromError,
  listPromptContexts,
  parseTraceLines,
  reconstructRunFromTrace,
} from '../agent/core/trace-replay.ts';

function line(event: Record<string, unknown>) {
  return JSON.stringify(event);
}

const RUN_META = {
  type: 'run_meta',
  runId: 'run_test1_aaaa',
  startedAt: 1000,
  task: '查询今天苏州天气',
  agentModels: ['nvidia/test-model'],
  strategy: 'race',
};

function doneRunLines() {
  return [
    line(RUN_META),
    line({ type: 'step', step: 1, stage: 'observe', observation: { title: 'Desktop', url: '' } }),
    line({
      type: 'model_plan', stage: 'success', step: 1, model: 'nvidia/test-model',
      rationale: '搜索天气', action: { tool: 'search', type: 'web_search', query: '苏州天气', maxResults: 10 },
    }),
    line({
      type: 'step', step: 1, stage: 'action', rationale: '搜索天气',
      action: { tool: 'search', type: 'web_search', query: '苏州天气', maxResults: 10 },
    }),
    line({ type: 'step', step: 1, stage: 'result', result: 'web_search 结果: 晴 30 度', resultStatus: 'success', resultError: null }),
    line({ type: 'step', step: 2, stage: 'observe', observation: { title: '天气页', url: 'https://weather.example.com/suzhou' } }),
    line({
      type: 'step', step: 2, stage: 'action', rationale: '完成',
      action: { tool: 'core', type: 'finish', answer: '今天苏州晴，30 度' },
    }),
    // finish 步没有 result 事件（与 runtime 行为一致）
    line({ type: 'done', answer: '今天苏州晴，30 度', quality: { status: 'done', reasons: [] } }),
  ].join('\n');
}

describe('parseTraceLines', () => {
  it('skips blank and malformed lines', () => {
    const events = parseTraceLines('\n{"type":"status","status":"ok"}\n{bad json}\n\n{"type":"error","error":"x"}\n');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('status');
    expect(events[1].type).toBe('error');
  });

  it('tolerates empty input', () => {
    expect(parseTraceLines('')).toEqual([]);
  });
});

describe('extractRawOutputFromError', () => {
  it('decodes the JSON-encoded raw output tail', () => {
    const raw = '{"rationale":"r","action":{"tool":"core","type":"finish"';
    const error = `模型动作解析失败: 解析失败; 原始输出=${JSON.stringify(raw)}`;
    expect(extractRawOutputFromError(error)).toBe(raw);
  });

  it('returns the tail as-is when not valid JSON', () => {
    expect(extractRawOutputFromError('解析失败; 原始输出=plain text')).toBe('plain text');
  });

  it('returns null when the marker is absent', () => {
    expect(extractRawOutputFromError('模型上下文太小')).toBeNull();
    expect(extractRawOutputFromError(undefined)).toBeNull();
  });
});

describe('reconstructRunFromTrace', () => {
  it('rebuilds a completed run with meta, steps, answer and recorded quality', () => {
    const run = reconstructRunFromTrace(parseTraceLines(doneRunLines()));

    expect(run.runId).toBe('run_test1_aaaa');
    expect(run.task).toBe('查询今天苏州天气');
    expect(run.agentModels).toEqual(['nvidia/test-model']);
    expect(run.strategy).toBe('race');
    expect(run.endedWith).toBe('done');
    expect(run.answer).toBe('今天苏州晴，30 度');
    expect(run.recordedQuality?.status).toBe('done');
    expect(run.parseFailures).toEqual([]);
    expect(run.pendingObservation).toBeNull();

    expect(run.steps).toHaveLength(2);
    expect(run.steps[0]).toMatchObject({
      step: 1,
      rationale: '搜索天气',
      action: { tool: 'search', type: 'web_search' },
      result: 'web_search 结果: 晴 30 度',
      resultStatus: 'success',
    });
    expect(run.steps[0].observation).toMatchObject({ title: 'Desktop' });
    // finish 步：有 action、无 result
    expect(run.steps[1].action.type).toBe('finish');
    expect(run.steps[1].result).toBeUndefined();
    // url/title 按 runtime 口径从 observation 推导
    expect(run.steps[1].url).toBe('https://weather.example.com/suzhou');
    expect(run.steps[1].title).toBe('天气页');
  });

  it('rebuilds an error-terminated run and extracts the parse-failure corpus', () => {
    const raw = '{"rationale":"回答","action":{"tool":"core","type":"finish","answer":"截断';
    const plannerError = `解析失败; 原始输出=${JSON.stringify(raw)}`;
    const lines = [
      line(RUN_META),
      line({ type: 'step', step: 1, stage: 'observe', observation: { title: 'Desktop' } }),
      line({
        type: 'step', step: 1, stage: 'action', rationale: '搜索',
        action: { tool: 'search', type: 'web_search', query: 'x', maxResults: 5 },
      }),
      line({ type: 'step', step: 1, stage: 'result', result: '结果文本', resultStatus: 'success' }),
      line({ type: 'step', step: 2, stage: 'observe', observation: { title: '页面', url: 'https://a.example.com' } }),
      line({ type: 'model_plan', stage: 'failed', step: 2, model: 'nvidia/test-model', error: plannerError }),
      // 结尾 error 事件复读同一段原文，应被去重
      line({ type: 'error', error: `模型动作解析失败: ${plannerError}` }),
    ].join('\n');

    const run = reconstructRunFromTrace(parseTraceLines(lines));

    expect(run.endedWith).toBe('error');
    expect(run.answer).toBe('');
    expect(run.steps).toHaveLength(1);
    // 已 observe 未执行的尾步保留为 pendingObservation，供 prompt 构建
    expect(run.pendingObservation).toMatchObject({ step: 2, observation: { title: '页面' } });
    expect(run.parseFailures).toHaveLength(1);
    expect(run.parseFailures[0]).toMatchObject({ step: 2, model: 'nvidia/test-model', rawOutput: raw });
  });

  it('keeps rejected steps that carry a result but no action event', () => {
    const lines = [
      line(RUN_META),
      line({ type: 'step', step: 1, stage: 'observe', observation: {} }),
      line({ type: 'step', step: 1, stage: 'result', result: '操作未获批准', resultStatus: 'rejected', resultError: '操作未获批准' }),
    ].join('\n');

    const run = reconstructRunFromTrace(parseTraceLines(lines));

    expect(run.endedWith).toBe('incomplete');
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].resultStatus).toBe('rejected');
    expect(run.steps[0].action).toBeUndefined();
  });

  it('lets later events win for the same step number after a rollback replay', () => {
    const lines = [
      line(RUN_META),
      line({ type: 'step', step: 1, stage: 'observe', observation: { title: '旧观察' } }),
      line({ type: 'step', step: 1, stage: 'action', rationale: '旧动作', action: { tool: 'browser', type: 'get_page_content' } }),
      line({ type: 'step', step: 1, stage: 'result', result: '旧结果', resultStatus: 'failed' }),
      line({ type: 'rollback', targetStep: 1, message: '回滚' }),
      line({ type: 'step', step: 1, stage: 'observe', observation: { title: '新观察' } }),
      line({ type: 'step', step: 1, stage: 'action', rationale: '新动作', action: { tool: 'browser', type: 'navigate', url: 'https://b.example.com' } }),
      line({ type: 'step', step: 1, stage: 'result', result: '新结果', resultStatus: 'success' }),
    ].join('\n');

    const run = reconstructRunFromTrace(parseTraceLines(lines));

    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ rationale: '新动作', result: '新结果', resultStatus: 'success' });
    expect(run.steps[0].url).toBe('https://b.example.com');
  });
});

describe('buildStepPromptContext / listPromptContexts', () => {
  it('rebuilds the decide-time context for each executed step', () => {
    const run = reconstructRunFromTrace(parseTraceLines(doneRunLines()));

    const first = buildStepPromptContext(run, 0);
    expect(first).toMatchObject({ task: '查询今天苏州天气', step: 1, history: [] });
    expect(first.observation).toMatchObject({ title: 'Desktop' });

    const second = buildStepPromptContext(run, 1);
    expect(second.step).toBe(2);
    expect(second.history).toHaveLength(1);
    expect(second.history[0].action.tool).toBe('search');
    expect(second.observation).toMatchObject({ title: '天气页' });
  });

  it('falls back to the previous observation when a step skipped observe', () => {
    const lines = [
      line(RUN_META),
      line({ type: 'step', step: 1, stage: 'observe', observation: { title: '第一步观察' } }),
      line({ type: 'step', step: 1, stage: 'action', rationale: 'a', action: { tool: 'browser', type: 'get_page_content' } }),
      line({ type: 'step', step: 1, stage: 'result', result: 'r1', resultStatus: 'success' }),
      // 第 2 步没有 observe 事件
      line({ type: 'step', step: 2, stage: 'action', rationale: 'b', action: { tool: 'core', type: 'finish', answer: 'ok' } }),
    ].join('\n');

    const run = reconstructRunFromTrace(parseTraceLines(lines));
    const context = buildStepPromptContext(run, 1);
    expect(context.observation).toMatchObject({ title: '第一步观察' });
  });

  it('appends the pending tail observation as an extra prompt context', () => {
    const lines = [
      line(RUN_META),
      line({ type: 'step', step: 1, stage: 'observe', observation: { title: 'o1' } }),
      line({ type: 'step', step: 1, stage: 'action', rationale: 'a', action: { tool: 'browser', type: 'get_page_content' } }),
      line({ type: 'step', step: 1, stage: 'result', result: 'r', resultStatus: 'success' }),
      line({ type: 'step', step: 2, stage: 'observe', observation: { title: 'o2' } }),
      line({ type: 'error', error: '模型动作解析失败' }),
    ].join('\n');

    const run = reconstructRunFromTrace(parseTraceLines(lines));
    const contexts = listPromptContexts(run);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toMatchObject({ step: 2 });
    expect(contexts[1].history).toHaveLength(1);
    expect(contexts[1].observation).toMatchObject({ title: 'o2' });
  });

  it('throws on an out-of-range step index', () => {
    const run = reconstructRunFromTrace(parseTraceLines(doneRunLines()));
    expect(() => buildStepPromptContext(run, 99)).toThrow(/越界/);
  });
});
