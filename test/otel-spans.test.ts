import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSpanAssembler, fallbackSessionId, type AssembledSpan } from '../helpers/telemetry/span-assembler.ts';
import { buildOtlpTracePayload } from '../helpers/telemetry/otlp-json.ts';
import { isValidSpanId, isValidTraceId, spanIdFor, traceIdFor } from '../helpers/telemetry/ids.ts';
import { parseTraceLines } from '../agent/core/trace-replay.ts';
import { createAgentRunStore } from '../helpers/run-store.ts';
import { createBaseEventSender } from '../helpers/run-agent.ts';
import { readTraceEvents } from '../helpers/trace-store.ts';
import { OPERATION, SAGENT_ATTR, ATTR, STATUS_CODE, SPAN_KIND } from '../helpers/telemetry/semconv.ts';

/** 一次典型的两步 run：observe → 双模型竞速 → 执行工具 → finish。 */
function twoStepRun(sessionId: string | null = 'session_abc'): any[] {
  return [
    { type: 'run_meta', startedAt: 1_000, model: 'nvidia/nemotron-3', agentModels: ['nvidia/nemotron-3', 'gemini-2.5-flash'], strategy: 'race', sessionId, timestamp: 1_000 },
    { type: 'step', step: 1, stage: 'observe', observation: { url: 'https://x' }, timestamp: 1_100 },
    { type: 'model_plan', step: 1, stage: 'start', models: ['nvidia/nemotron-3', 'gemini-2.5-flash'], timestamp: 1_150 },
    { type: 'model_plan', step: 1, stage: 'thinking', model: 'nvidia/nemotron-3', timestamp: 1_200 },
    { type: 'model_plan', step: 1, stage: 'thinking', model: 'gemini-2.5-flash', timestamp: 1_200 },
    { type: 'model_plan', step: 1, stage: 'winner', model: 'nvidia/nemotron-3', usage: { prompt_tokens: 100, completion_tokens: 20 }, timestamp: 1_800 },
    { type: 'model_plan', step: 1, stage: 'cancelled', model: 'gemini-2.5-flash', timestamp: 1_850 },
    { type: 'step', step: 1, stage: 'action', action: { tool: 'fs', type: 'read_file', path: '/tmp/a' }, timestamp: 1_900 },
    { type: 'terminal_output', step: 1, phase: 'stdout', sequence: 1, chunk: 'hello', timestamp: 1_950 },
    { type: 'step', step: 1, stage: 'result', result: 'ok', resultStatus: 'success', timestamp: 2_000 },
    { type: 'step', step: 2, stage: 'observe', observation: {}, timestamp: 2_100 },
    { type: 'model_plan', step: 2, stage: 'winner', model: 'nvidia/nemotron-3', usage: { prompt_tokens: 50, completion_tokens: 10 }, timestamp: 2_400 },
    { type: 'step', step: 2, stage: 'action', action: { tool: 'core', type: 'finish', answer: 'done' }, timestamp: 2_500 },
    { type: 'done', answer: 'done', meta: { status: 'done', step_count: 2 }, quality: { status: 'done' }, timestamp: 2_600 },
  ];
}

function assemble(events: any[], { runId = 'run_test_a', attempt = 1, sessionId = 'session_abc' } = {}) {
  const assembler = createSpanAssembler({ sessionId, runId, attempt });
  for (const event of events) assembler.consume(event);
  return assembler.flush();
}

const byName = (spans: AssembledSpan[], name: string) => spans.find(span => span.name === name);
const parentOf = (spans: AssembledSpan[], span: AssembledSpan | undefined) =>
  spans.find(candidate => candidate.spanId === span?.parentSpanId);

describe('OTel span assembler', () => {
  it('把事件流组装成 run → step → observe/chat/execute 的 span 树', () => {
    const spans = assemble(twoStepRun());

    const run = byName(spans, 'invoke_agent sagent');
    expect(run).toBeDefined();
    expect(run!.parentSpanId).toBeNull();
    expect(run!.attributes[ATTR.OPERATION_NAME]).toBe(OPERATION.INVOKE_AGENT);
    expect(run!.attributes[ATTR.CONVERSATION_ID]).toBe('session_abc');
    expect(run!.attributes[ATTR.REQUEST_MODEL]).toBe('nvidia/nemotron-3');
    expect(run!.attributes[SAGENT_ATTR.RUN_STRATEGY]).toBe('race');
    expect(run!.status.code).toBe(STATUS_CODE.OK);

    // 两步都在 run 下面
    const step1 = byName(spans, 'step 1');
    const step2 = byName(spans, 'step 2');
    expect(parentOf(spans, step1)).toBe(run);
    expect(parentOf(spans, step2)).toBe(run);

    // observe / chat / execute_tool 都挂在所属 step 下
    const observe = spans.filter(span => span.name === 'observe');
    expect(observe).toHaveLength(2);
    expect(parentOf(spans, observe[0])).toBe(step1);

    const chatNvidia = byName(spans, 'chat nvidia/nemotron-3');
    expect(parentOf(spans, chatNvidia)).toBe(step1);
    expect(chatNvidia!.kind).toBe(SPAN_KIND.CLIENT);
    expect(chatNvidia!.attributes[ATTR.OPERATION_NAME]).toBe(OPERATION.CHAT);
    expect(chatNvidia!.attributes[ATTR.PROVIDER_NAME]).toBe('nvidia');
    expect(chatNvidia!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(100);
    // thinking(1200) → winner(1800)
    expect(chatNvidia!.endTimeMs - chatNvidia!.startTimeMs).toBe(600);

    // gemini 走另一个 provider 命名
    expect(byName(spans, 'chat gemini-2.5-flash')!.attributes[ATTR.PROVIDER_NAME]).toBe('gcp.gen_ai');

    const execute = byName(spans, 'execute_tool fs.read_file');
    expect(parentOf(spans, execute)).toBe(step1);
    expect(execute!.attributes[ATTR.OPERATION_NAME]).toBe(OPERATION.EXECUTE_TOOL);
    expect(execute!.attributes[ATTR.TOOL_NAME]).toBe('fs.read_file');
    expect(execute!.attributes[SAGENT_ATTR.RESULT_STATUS]).toBe('success');
    // action(1900) → result(2000)
    expect(execute!.endTimeMs - execute!.startTimeMs).toBe(100);
  });

  it('汇总整个 run 的 token 用量，且不因 success/winner 重复计数', () => {
    const events = twoStepRun();
    // race 策略下同一模型会先后报 success 与 winner，两者带同一份用量
    events.splice(5, 0, {
      type: 'model_plan', step: 1, stage: 'success', model: 'nvidia/nemotron-3',
      usage: { prompt_tokens: 100, completion_tokens: 20 }, timestamp: 1_790,
    });

    const run = byName(assemble(events), 'invoke_agent sagent')!;
    expect(run.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(150);
    expect(run.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(30);
  });

  it('terminal/mcp 输出记为 span event，不各开一个 span', () => {
    const spans = assemble(twoStepRun());
    const execute = byName(spans, 'execute_tool fs.read_file')!;

    expect(spans.some(span => span.name === 'terminal_output')).toBe(false);
    expect(execute.events.map(event => event.name)).toContain('terminal_output');
    expect(execute.events[0].attributes['sagent.output.phase']).toBe('stdout');
  });

  it('同一会话的多次 run 共享 trace_id，各自是独立的根 span', () => {
    const first = assemble(twoStepRun(), { runId: 'run_test_a' });
    const second = assemble(twoStepRun(), { runId: 'run_test_b' });

    const rootA = byName(first, 'invoke_agent sagent')!;
    const rootB = byName(second, 'invoke_agent sagent')!;

    expect(rootA.traceId).toBe(rootB.traceId);
    expect(rootA.spanId).not.toBe(rootB.spanId);
    expect(rootA.parentSpanId).toBeNull();
    expect(rootB.parentSpanId).toBeNull();
  });

  it('不同会话落在不同 trace 上', () => {
    const a = assemble(twoStepRun('session_a'), { sessionId: 'session_a' });
    const b = assemble(twoStepRun('session_b'), { sessionId: 'session_b' });
    expect(a[0].traceId).not.toBe(b[0].traceId);
  });

  it('重试复用 runId 时，attempt 让同名步骤得到不同 span_id', () => {
    const first = assemble(twoStepRun(), { runId: 'run_retry', attempt: 1 });
    const second = assemble(twoStepRun(), { runId: 'run_retry', attempt: 2 });

    expect(byName(first, 'step 1')!.traceId).toBe(byName(second, 'step 1')!.traceId);
    expect(byName(first, 'step 1')!.spanId).not.toBe(byName(second, 'step 1')!.spanId);
  });

  it('事件自带的 attempt 覆盖构造参数', () => {
    const events = twoStepRun().map(event => ({ ...event, attempt: 3 }));
    const withEventAttempt = byName(assemble(events, { attempt: 1 }), 'step 1')!;
    const withOptionAttempt = byName(assemble(twoStepRun(), { attempt: 3 }), 'step 1')!;
    expect(withEventAttempt.spanId).toBe(withOptionAttempt.spanId);
  });

  it('失败与取消在 run 根 span 上标成 ERROR 且带低基数 error.type', () => {
    const failed = assemble([
      ...twoStepRun().slice(0, 3),
      { type: 'error', error: '网络超时 timeout', timestamp: 3_000 },
    ]);
    const failedRun = byName(failed, 'invoke_agent sagent')!;
    expect(failedRun.status.code).toBe(STATUS_CODE.ERROR);
    expect(failedRun.attributes[ATTR.ERROR_TYPE]).toBe('timeout');
    expect(failedRun.attributes[SAGENT_ATTR.RUN_STATUS]).toBe('failed');

    const cancelled = assemble([
      ...twoStepRun().slice(0, 3),
      { type: 'error', error: 'Agent 已取消', timestamp: 3_000 },
    ]);
    const cancelledRun = byName(cancelled, 'invoke_agent sagent')!;
    expect(cancelledRun.attributes[ATTR.ERROR_TYPE]).toBe('cancelled');
    expect(cancelledRun.attributes[SAGENT_ATTR.RUN_STATUS]).toBe('cancelled');
  });

  it('工具执行失败标成 ERROR', () => {
    const events = twoStepRun();
    events[9] = { type: 'step', step: 1, stage: 'result', result: '失败', resultStatus: 'failed', resultError: 'ENOENT', timestamp: 2_000 };
    const execute = byName(assemble(events), 'execute_tool fs.read_file')!;
    expect(execute.status.code).toBe(STATUS_CODE.ERROR);
    expect(execute.attributes[ATTR.ERROR_TYPE]).toBe('tool_error');
  });

  it('审批与提问各成一个子 span', () => {
    const spans = assemble([
      { type: 'run_meta', startedAt: 1_000, model: 'm1', sessionId: 'session_abc', timestamp: 1_000 },
      { type: 'step', step: 1, stage: 'observe', observation: {}, timestamp: 1_100 },
      { type: 'approval_required', step: 1, approvalId: 'ap1', action: { tool: 'terminal', type: 'run_confirmed' }, timestamp: 1_200 },
      { type: 'approval_result', step: 1, approvalId: 'ap1', decision: 'reject', action: { tool: 'terminal', type: 'run_confirmed' }, message: '用户拒绝', timestamp: 1_500 },
      { type: 'step', step: 1, stage: 'result', result: '操作未获批准', resultStatus: 'rejected', timestamp: 1_600 },
      { type: 'done', answer: '', meta: { status: 'done' }, timestamp: 1_700 },
    ]);

    const approval = byName(spans, 'approval')!;
    expect(approval.attributes[SAGENT_ATTR.APPROVAL_DECISION]).toBe('reject');
    expect(approval.status.code).toBe(STATUS_CODE.ERROR);
    expect(approval.endTimeMs - approval.startTimeMs).toBe(300);
    expect(parentOf(spans, approval)).toBe(byName(spans, 'step 1'));

    // 被拒的步没有 action 事件，execute span 仍应由 result 事件补出
    const execute = spans.find(span => span.name.startsWith('execute_tool'))!;
    expect(execute.attributes[SAGENT_ATTR.RESULT_STATUS]).toBe('rejected');
  });

  it('finish 步没有 result 事件，收尾时仍会被关闭', () => {
    const spans = assemble(twoStepRun());
    // 每个 span 都有非负时长且已闭合
    expect(spans.every(span => span.endTimeMs >= span.startTimeMs)).toBe(true);
    expect(byName(spans, 'step 2')).toBeDefined();
    expect(spans.filter(span => span.name === 'step 2')).toHaveLength(1);
  });

  it('迟到事件挂到已关闭的 span 上，不会重开出一个同名 span', () => {
    // session_checkpoint 排在本步 result 之后（真实 trace 里就是这个顺序）。
    // 早期实现会在这里重建 step span，导致 trace 里每步出现两次。
    const events = twoStepRun();
    events.splice(10, 0, { type: 'session_checkpoint', step: 1, message: '已创建第 1 步健康快照', timestamp: 2_050 });
    const spans = assemble(events);

    expect(spans.filter(span => span.name === 'step 1')).toHaveLength(1);
    expect(spans.filter(span => span.name === 'observe')).toHaveLength(2); // 两步各一个
    expect(new Set(spans.map(span => span.spanId)).size).toBe(spans.length);
    // 迟到事件本身作为 span event 记在 step 1 上
    expect(byName(spans, 'step 1')!.events.map(event => event.name)).toContain('session_checkpoint');
  });

  it('flush 可重复调用而不重复产出 span', () => {
    const assembler = createSpanAssembler({ sessionId: 'session_abc', runId: 'run_test_a' });
    for (const event of twoStepRun()) assembler.consume(event);
    const first = assembler.flush();
    const second = assembler.flush();
    expect(second).toHaveLength(first.length);
  });

  it('无 sessionId 时回退到与 session-store 一致的规则', () => {
    const runId = 'run_mrjcxla1_n5534t';
    const assembler = createSpanAssembler({ sessionId: null, runId });
    expect(assembler.sessionId).toBe(fallbackSessionId(runId));
    expect(assembler.sessionId).toBe('session_trace_mrjcxla1_n5534t');
    expect(assembler.traceId).toBe(traceIdFor(`session_trace_${runId.slice(4)}`));
  });
});

describe('W3C trace/span ID', () => {
  it('派生出合法的 32/16 位小写 hex', () => {
    const traceId = traceIdFor('session_abc');
    const spanId = spanIdFor('run_test_a', 1, 'step.1.execute');

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(isValidTraceId(traceId)).toBe(true);
    expect(isValidSpanId(spanId)).toBe(true);
  });

  it('是确定性的：同输入必得同输出', () => {
    expect(traceIdFor('session_abc')).toBe(traceIdFor('session_abc'));
    expect(spanIdFor('run_a', 1, 'step.1')).toBe(spanIdFor('run_a', 1, 'step.1'));
    expect(spanIdFor('run_a', 1, 'step.1')).not.toBe(spanIdFor('run_a', 2, 'step.1'));
  });

  it('拒绝全零这种协议保留的无效 ID', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
    expect(isValidTraceId('ABC')).toBe(false);
  });

  it('分隔输入，避免拼接歧义', () => {
    // 若不加分隔符，('ab','c') 与 ('a','bc') 会拼出同一个字符串
    expect(spanIdFor('ab', 1, 'c')).not.toBe(spanIdFor('a', 1, 'bc'));
  });

  it('组装出的每个 span ID 都合法且互不相同', () => {
    const spans = assemble(twoStepRun());
    expect(spans.every(span => isValidTraceId(span.traceId))).toBe(true);
    expect(spans.every(span => isValidSpanId(span.spanId))).toBe(true);
    expect(new Set(spans.map(span => span.spanId)).size).toBe(spans.length);
  });
});

describe('OTLP/JSON 序列化', () => {
  it('产出符合规范的 resourceSpans → scopeSpans → spans 结构', () => {
    const payload: any = buildOtlpTracePayload(assemble(twoStepRun()), { serviceName: 'sagent' });

    expect(payload.resourceSpans).toHaveLength(1);
    const resource = payload.resourceSpans[0];
    expect(resource.resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'sagent' },
    });
    expect(resource.scopeSpans).toHaveLength(1);
    expect(resource.scopeSpans[0].scope.name).toBe('sagent.telemetry.trace-export');

    const span = resource.scopeSpans[0].spans.find((item: any) => item.name === 'invoke_agent sagent');
    // ID 用 hex 字符串，不是 base64（OTLP/JSON 对标准 protobuf JSON 映射的显式偏离）
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.parentSpanId).toBeUndefined();
    // 枚举必须是整数
    expect(typeof span.kind).toBe('number');
    expect(typeof span.status.code).toBe('number');
  });

  it('纳秒时间戳用十进制字符串且不丢精度', () => {
    const nowMs = 1_783_955_313_162;
    const payload: any = buildOtlpTracePayload([{
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      name: 'x',
      kind: 1,
      startTimeMs: nowMs,
      endTimeMs: nowMs + 500,
      attributes: {},
      events: [],
      status: { code: 0 },
    }]);

    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.startTimeUnixNano).toBe('1783955313162000000');
    expect(span.endTimeUnixNano).toBe('1783955313662000000');
    // 该值超出 Number.MAX_SAFE_INTEGER —— 必须是字符串才不丢精度
    expect(Number(span.startTimeUnixNano) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(typeof span.startTimeUnixNano).toBe('string');
  });

  it('按类型包装属性值', () => {
    const payload: any = buildOtlpTracePayload([{
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      name: 'x',
      kind: 1,
      startTimeMs: 1,
      endTimeMs: 2,
      attributes: { s: 'text', i: 42, d: 1.5, b: true },
      events: [],
      status: { code: 0 },
    }]);

    const attributes = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    const find = (key: string) => attributes.find((item: any) => item.key === key).value;
    expect(find('s')).toEqual({ stringValue: 'text' });
    // 64 位整数编码为十进制字符串
    expect(find('i')).toEqual({ intValue: '42' });
    expect(find('d')).toEqual({ doubleValue: 1.5 });
    expect(find('b')).toEqual({ boolValue: true });
  });
});

describe('与运行时事件流的一致性', () => {
  it('createBaseEventSender 写进 trace 的 ID 与离线重放算出的完全一致', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-otel-'));
    try {
      const runId = 'run_otel1_abcdef';
      const store = createAgentRunStore();
      const run = store.createRun({}, 1_000, runId);
      const send = createBaseEventSender(runId, store, tmpDir, { sessionId: 'session_abc', attempt: 1 });

      for (const event of twoStepRun()) send(event as any);
      await run.persistence?.flush();

      const persisted = await readTraceEvents(tmpDir, runId);
      // 在线写入的每个事件都带合规 ID
      expect(persisted.every((event: any) => isValidTraceId(event.trace_id))).toBe(true);
      expect(persisted.every((event: any) => isValidSpanId(event.span_id))).toBe(true);
      // 全部落在同一棵 trace 上
      expect(new Set(persisted.map((event: any) => event.trace_id)).size).toBe(1);

      // 离线重放读回同一份文件，在线写下的每个 span_id 都必须能对应到一个真实 span。
      // 反向不成立：step N 这类容器 span 没有「属于它」的事件（事件都归到
      // observe/chat/execute 子 span），所以只做子集断言。
      const offline = assemble(persisted, { runId, sessionId: 'session_abc' });
      const offlineSpanIds = new Set(offline.map(span => span.spanId));
      for (const event of persisted as any[]) {
        expect(offlineSpanIds.has(event.span_id)).toBe(true);
      }
      // 父指针也必须落在同一棵树里
      for (const event of (persisted as any[]).filter(item => item.parent_id)) {
        expect(offlineSpanIds.has(event.parent_id)).toBe(true);
      }
      expect(offline[0].traceId).toBe(persisted[0].trace_id);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('隐私 run 不落 trace，因而不产出任何可导出的 span', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-otel-private-'));
    try {
      const runId = 'run_otel2_private';
      const store = createAgentRunStore();
      const run = store.createRun({ privateMode: true }, 1_000, runId);
      const send = createBaseEventSender(runId, store, tmpDir, {
        persistTrace: false,
        sessionId: 'session_private',
      });

      for (const event of twoStepRun()) send(event as any);
      await run.persistence?.flush();

      expect(await readTraceEvents(tmpDir, runId)).toEqual([]);
      await expect(fs.access(path.join(tmpDir, 'traces'))).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('历史 trace 迁移', () => {
  it('旧格式（span_id 为 "step_1_observe" 之类）的存量 fixture 可直接转换', async () => {
    const fixturesDir = path.resolve('data/eval-fixtures/traces');
    let files: string[] = [];
    try {
      files = (await fs.readdir(fixturesDir)).filter(file => file.endsWith('.jsonl'));
    } catch {
      return; // fixture 是本地产物，CI 上没有就跳过
    }
    if (files.length === 0) return;

    const raw = await fs.readFile(path.join(fixturesDir, files[0]), 'utf8');
    const events = parseTraceLines(raw);
    const runId = (events.find((event: any) => event?.runId) as any)?.runId || 'run_fixture_x';

    // 旧文件里存的是可读字符串 span_id；组装器必须无视它、从内容重新派生
    const legacy = events.map((event: any) => event.span_id).filter(Boolean);
    expect(legacy.some((id: string) => !isValidSpanId(id))).toBe(true);

    const spans = assemble(events, { runId });
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(span => isValidSpanId(span.spanId))).toBe(true);
    expect(spans.every(span => isValidTraceId(span.traceId))).toBe(true);
    expect(spans.every(span => span.endTimeMs >= span.startTimeMs)).toBe(true);
    // 有且只有一个根 span
    expect(spans.filter(span => span.parentSpanId === null)).toHaveLength(1);
    // span ID 唯一 —— 迟到事件重开 span 会在这里暴露成重复
    expect(new Set(spans.map(span => span.spanId)).size).toBe(spans.length);
    // 每个 step 只出现一次
    const stepNames = spans.map(span => span.name).filter(name => /^step \d+$/.test(name));
    expect(new Set(stepNames).size).toBe(stepNames.length);
    // 每个非根 span 的父指针都能在树里找到
    const ids = new Set(spans.map(span => span.spanId));
    expect(spans.every(span => span.parentSpanId === null || ids.has(span.parentSpanId))).toBe(true);

    const payload: any = buildOtlpTracePayload(spans);
    expect(payload.resourceSpans[0].scopeSpans[0].spans.length).toBe(spans.length);
  });
});
