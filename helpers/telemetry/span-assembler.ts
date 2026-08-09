/**
 * Span 组装器 —— 把有序的 AgentEvent 流翻译成 OpenTelemetry span 树。
 *
 * 为什么放在事件层而不是 runtime 里埋点：
 *   所有事件（含 sandboxed worker 里产生的）最终都汇聚到 helpers/run-agent.ts 的
 *   createBaseEventSender。在这一层做组装，两种 runner 自动都覆盖到，runtime.ts 的
 *   步骤循环一行都不用改，也不需要跨进程传播 OTel context。
 *
 * 两个消费者共用本模块，因此产出必然一致：
 *   - 在线：createBaseEventSender 边发事件边组装，把合规 ID 回填进 JSONL
 *   - 离线：scripts/trace-to-otlp.ts 重读 JSONL 再组装一遍，转成 OTLP/JSON
 *   ID 由纯哈希派生（见 ids.ts），所以两条路算出的 span 树逐字节相同。
 *
 * Span 树形状：
 *   trace = 一个 chat session
 *   └── invoke_agent sagent          run 根 span（同会话的多次 run 是并列的根）
 *       └── step N
 *           ├── observe              环境观察
 *           ├── chat <model>         每个参与决策的模型一个
 *           ├── execute_tool <tool>  工具执行（terminal/mcp 输出挂成 span event）
 *           └── approval             仅在真的触发审批/提问时出现
 *
 * 时序的已知近似：
 *   事件流只在每个阶段**结束**时给一个时间点，没有开始时间。所以除 execute
 *   （由 action 事件精确标记起点）外，各 span 的 startTime 取「上一个事件的时间戳」。
 *   这与 run-agent.ts 原先计算 duration_ms 的口径完全一致，是既有近似，
 *   不引入新的误差。
 */

import { spanIdFor, traceIdFor } from './ids.ts';
import {
  AGENT_NAME,
  ATTR,
  OPERATION,
  SAGENT_ATTR,
  SPAN_KIND,
  STATUS_CODE,
  providerNameFromModel,
  toolNameFromAction,
} from './semconv.ts';

export type SpanAttributeValue = string | number | boolean;

export interface AssembledSpanEvent {
  name: string;
  timeMs: number;
  attributes: Record<string, SpanAttributeValue>;
}

export interface AssembledSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, SpanAttributeValue>;
  events: AssembledSpanEvent[];
  status: { code: number; message?: string };
}

/** consume() 的返回值：供调用方回填进 JSONL 事件。 */
export interface EventTraceRef {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
}

export interface SpanAssemblerOptions {
  /** 会话 ID，决定 trace_id。缺省时按 session-store 的同一规则从 runId 回退。 */
  sessionId?: string | null;
  runId: string;
  /** 事件自带 attempt 时以事件为准；这里只是没有 attempt 字段时的兜底。 */
  attempt?: number;
  projectId?: string | null;
}

/** 无显式会话时的 trace 归属，与 agent/core/session-store.ts 的回退规则保持一致。 */
export function fallbackSessionId(runId: string): string {
  return `session_trace_${String(runId || '').slice(4)}`;
}

interface OpenSpan extends AssembledSpan {
  /** 组装期内部用的稳定 key，不进入输出。 */
  key: string;
}

function setAttr(
  attributes: Record<string, SpanAttributeValue>,
  key: string,
  value: unknown,
) {
  if (value == null || value === '') return;
  if (typeof value === 'string' || typeof value === 'boolean') {
    attributes[key] = value;
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    attributes[key] = value;
  }
}

/** 归一化为低基数的 error.type：不要把原始错误文本塞进去，会炸掉 collector 的索引。 */
function errorTypeOf(message: string | null | undefined): string {
  const text = String(message ?? '');
  if (text.includes('已取消')) return 'cancelled';
  if (/timeout|超时/i.test(text)) return 'timeout';
  return 'agent_error';
}

export function createSpanAssembler({
  sessionId,
  runId,
  attempt: defaultAttempt = 1,
  projectId = null,
}: SpanAssemblerOptions) {
  const resolvedSessionId = String(sessionId || '').trim() || fallbackSessionId(runId);
  const traceId = traceIdFor(resolvedSessionId);

  const completed: OpenSpan[] = [];
  /** 所有创建过的 span，按 key 索引（含已关闭的）。 */
  const spansByKey = new Map<string, OpenSpan>();
  /** 仍未关闭的 span key。 */
  const openKeys = new Set<string>();
  /** 每个模型本步开始「思考」的时间，用于给 chat span 定起点。 */
  const modelStartTs = new Map<string, number>();
  /** 每步 model_plan 的整体起点，模型没单独报 thinking 时兜底。 */
  const planStartTs = new Map<number, number>();
  /** 逐 (step, model) 记录用量，避免 success 与 winner 事件重复计数。 */
  const usageByModel = new Map<string, { input: number; output: number }>();

  /** 上一个已处理事件的时间戳，作为新 span 的默认起点。 */
  let cursorTs = 0;
  let currentAttempt = defaultAttempt;
  let runStrategy: string | null = null;
  let runModel: string | null = null;

  function spanKeyId(key: string) {
    return spanIdFor(runId, currentAttempt, key);
  }

  /**
   * 取或建一个 span。
   *
   * 关键：已关闭的 span 直接返回原对象，**不重开**。事件流里存在「迟到事件」——
   * 例如 session_checkpoint 排在本步 result 之后，此时 step span 已经关闭。
   * 若在这里重建，同一个 key 会被 push 两次，trace 里就会出现两个同名 step。
   * 返回已关闭的原对象则让迟到事件挂成它的 span event，语义也更准确。
   */
  function openSpan(
    key: string,
    {
      name,
      kind = SPAN_KIND.INTERNAL,
      parentKey,
      startTimeMs,
      attributes = {},
    }: {
      name: string;
      kind?: number;
      parentKey: string | null;
      startTimeMs: number;
      attributes?: Record<string, SpanAttributeValue>;
    },
  ): OpenSpan {
    const existing = spansByKey.get(key);
    if (existing) return existing;

    const span: OpenSpan = {
      key,
      traceId,
      spanId: spanKeyId(key),
      parentSpanId: parentKey ? spanKeyId(parentKey) : null,
      name,
      kind,
      startTimeMs,
      endTimeMs: startTimeMs,
      attributes,
      events: [],
      status: { code: STATUS_CODE.UNSET },
    };
    spansByKey.set(key, span);
    openKeys.add(key);
    // 存的是对象引用，所以关闭之后再追加 span event 依然会体现在输出里。
    completed.push(span);
    return span;
  }

  function closeSpan(key: string, endTimeMs: number) {
    const span = spansByKey.get(key);
    if (!span || !openKeys.has(key)) return;
    openKeys.delete(key);
    // 事件时间戳理论上单调，但 trace 文件可能被回滚/重放打乱；钳制以免产生负时长。
    span.endTimeMs = Math.max(endTimeMs, span.startTimeMs);
  }

  /** run 根 span 必须存在——所有其它 span 都挂在它下面。 */
  function ensureRunSpan(startTimeMs: number): OpenSpan {
    return openSpan('run', {
      name: `${OPERATION.INVOKE_AGENT} ${AGENT_NAME}`,
      parentKey: null,
      startTimeMs,
      attributes: {
        [ATTR.OPERATION_NAME]: OPERATION.INVOKE_AGENT,
        [ATTR.AGENT_NAME]: AGENT_NAME,
        [ATTR.CONVERSATION_ID]: resolvedSessionId,
        [SAGENT_ATTR.RUN_ID]: runId,
        [SAGENT_ATTR.RUN_ATTEMPT]: currentAttempt,
      },
    });
  }

  function ensureStepSpan(step: number, startTimeMs: number): OpenSpan {
    ensureRunSpan(startTimeMs);
    return openSpan(`step.${step}`, {
      name: `step ${step}`,
      parentKey: 'run',
      startTimeMs,
      attributes: { [SAGENT_ATTR.STEP_NUMBER]: step },
    });
  }

  /**
   * 新的一步开始时，关掉上一步还开着的 span。
   *
   * 需要这个是因为 finish 动作不会产生 result 事件（见 runtime.ts 对 finish 的处理），
   * 审批被拒的步也没有 action 事件，光靠事件本身关不干净。
   */
  function closeStalePriorSteps(currentStep: number, atMs: number) {
    for (const key of [...openKeys]) {
      if (key === 'run') continue;
      const step = Number(key.split('.')[1]);
      if (Number.isFinite(step) && step < currentStep) {
        closeSpan(key, atMs);
      }
    }
  }

  function recordUsage(step: number, model: string, usage: any) {
    const input = Number(usage?.prompt_tokens);
    const output = Number(usage?.completion_tokens ?? usage?.output_tokens);
    if (!Number.isFinite(input) && !Number.isFinite(output)) return;
    // 同一 (step, model) 只记一次：race 策略下 success 与 winner 会带同一份用量。
    const mapKey = `${step}:${model}`;
    if (usageByModel.has(mapKey)) return;
    usageByModel.set(mapKey, {
      input: Number.isFinite(input) ? input : 0,
      output: Number.isFinite(output) ? output : 0,
    });
  }

  function totalUsage() {
    let input = 0;
    let output = 0;
    for (const value of usageByModel.values()) {
      input += value.input;
      output += value.output;
    }
    return { input, output };
  }

  /**
   * 处理一个事件：更新 span 树，返回该事件所属 span 的追踪引用。
   *
   * 多个事件映射到同一个 span 是正常的——action 与 result 都属于同一个
   * execute_tool span，terminal_output 也是它的 span event，而非独立 span。
   */
  function consume(event: any): EventTraceRef {
    const ts = Number.isFinite(event?.timestamp) ? Number(event.timestamp) : cursorTs || Date.now();
    const spanStart = cursorTs || ts;
    if (Number.isInteger(event?.attempt) && event.attempt > 0) {
      currentAttempt = event.attempt;
    }
    const step = Number.isFinite(event?.step) ? Number(event.step) : null;
    let owner: OpenSpan;

    switch (event?.type) {
      case 'run_meta': {
        const startedAt = Number.isFinite(event.startedAt) ? Number(event.startedAt) : ts;
        owner = ensureRunSpan(startedAt);
        runModel = event.model || runModel;
        runStrategy = event.strategy || runStrategy;
        setAttr(owner.attributes, ATTR.REQUEST_MODEL, event.model);
        setAttr(owner.attributes, ATTR.PROVIDER_NAME, providerNameFromModel(event.model));
        setAttr(owner.attributes, SAGENT_ATTR.RUN_STRATEGY, event.strategy);
        setAttr(owner.attributes, SAGENT_ATTR.PROJECT_ID, event.projectId ?? projectId);
        if (event.privateMode === true) {
          setAttr(owner.attributes, SAGENT_ATTR.RUN_PRIVATE, true);
        }
        break;
      }

      case 'step': {
        if (step == null) {
          owner = ensureRunSpan(spanStart);
          break;
        }
        closeStalePriorSteps(step, spanStart);
        const stepSpan = ensureStepSpan(step, spanStart);

        if (event.stage === 'observe') {
          owner = openSpan(`step.${step}.observe`, {
            name: 'observe',
            parentKey: `step.${step}`,
            startTimeMs: spanStart,
            attributes: { [SAGENT_ATTR.STEP_STAGE]: 'observe', [SAGENT_ATTR.STEP_NUMBER]: step },
          });
          closeSpan(owner.key, ts);
          break;
        }

        if (event.stage === 'action') {
          // action 事件紧挨着 execute() 调用发出，是少有的精确起点。
          owner = openSpan(`step.${step}.execute`, {
            name: `${OPERATION.EXECUTE_TOOL} ${toolNameFromAction(event.action)}`,
            parentKey: `step.${step}`,
            startTimeMs: ts,
            attributes: {
              [ATTR.OPERATION_NAME]: OPERATION.EXECUTE_TOOL,
              [ATTR.TOOL_NAME]: toolNameFromAction(event.action),
              [ATTR.TOOL_TYPE]: 'function',
              [ATTR.AGENT_NAME]: AGENT_NAME,
              [SAGENT_ATTR.STEP_NUMBER]: step,
            },
          });
          setAttr(owner.attributes, SAGENT_ATTR.ACTION_TOOL, event.action?.tool);
          setAttr(owner.attributes, SAGENT_ATTR.ACTION_TYPE, event.action?.type);
          break;
        }

        // stage === 'result'
        // 审批被拒的步没有 action 事件，此时 execute span 由这里补开。
        owner = openSpan(`step.${step}.execute`, {
          name: OPERATION.EXECUTE_TOOL,
          parentKey: `step.${step}`,
          startTimeMs: spanStart,
          attributes: {
            [ATTR.OPERATION_NAME]: OPERATION.EXECUTE_TOOL,
            [ATTR.AGENT_NAME]: AGENT_NAME,
            [SAGENT_ATTR.STEP_NUMBER]: step,
          },
        });
        setAttr(owner.attributes, SAGENT_ATTR.RESULT_STATUS, event.resultStatus);
        if (event.resultStatus === 'failed' || event.resultStatus === 'rejected') {
          owner.status = { code: STATUS_CODE.ERROR, message: event.resultError || undefined };
          setAttr(
            owner.attributes,
            ATTR.ERROR_TYPE,
            event.resultStatus === 'rejected' ? 'rejected' : 'tool_error',
          );
        }
        closeSpan(owner.key, ts);
        closeSpan(`step.${step}`, ts);
        break;
      }

      case 'model_plan': {
        if (step == null) {
          owner = ensureRunSpan(spanStart);
          break;
        }
        ensureStepSpan(step, spanStart);
        if (event.stage === 'start') {
          planStartTs.set(step, ts);
          // 这一批模型的调度开始，尚无单个模型可归属，挂到 step 上。
          owner = spansByKey.get(`step.${step}`)!;
          break;
        }

        const model = String(event.model || '').trim();
        if (!model) {
          owner = spansByKey.get(`step.${step}`) || ensureStepSpan(step, spanStart);
          break;
        }

        const chatKey = `step.${step}.chat.${model}`;
        if (event.stage === 'thinking') {
          modelStartTs.set(chatKey, ts);
        }
        const chatStart = modelStartTs.get(chatKey) ?? planStartTs.get(step) ?? spanStart;
        owner = openSpan(chatKey, {
          name: `${OPERATION.CHAT} ${model}`,
          kind: SPAN_KIND.CLIENT,
          parentKey: `step.${step}`,
          startTimeMs: chatStart,
          attributes: {
            [ATTR.OPERATION_NAME]: OPERATION.CHAT,
            [ATTR.REQUEST_MODEL]: model,
            [ATTR.PROVIDER_NAME]: providerNameFromModel(model),
            [SAGENT_ATTR.STEP_NUMBER]: step,
          },
        });
        setAttr(owner.attributes, SAGENT_ATTR.PLAN_STAGE, event.stage);
        if (event.usage) {
          recordUsage(step, model, event.usage);
          setAttr(owner.attributes, ATTR.USAGE_INPUT_TOKENS, Number(event.usage.prompt_tokens));
          setAttr(
            owner.attributes,
            ATTR.USAGE_OUTPUT_TOKENS,
            Number(event.usage.completion_tokens ?? event.usage.output_tokens),
          );
          setAttr(owner.attributes, ATTR.RESPONSE_MODEL, model);
        }
        if (event.stage === 'failed') {
          owner.status = { code: STATUS_CODE.ERROR, message: event.error || undefined };
          setAttr(owner.attributes, ATTR.ERROR_TYPE, 'model_error');
        }
        if (['success', 'winner', 'failed', 'cancelled'].includes(event.stage)) {
          closeSpan(chatKey, ts);
        }
        break;
      }

      case 'approval_required':
      case 'question_required': {
        const key = step == null ? 'run.approval' : `step.${step}.approval`;
        if (step != null) ensureStepSpan(step, spanStart);
        else ensureRunSpan(spanStart);
        owner = openSpan(key, {
          name: event.type === 'question_required' ? 'ask_user' : 'approval',
          parentKey: step == null ? 'run' : `step.${step}`,
          startTimeMs: ts,
          attributes: {
            [ATTR.TOOL_NAME]: toolNameFromAction(event.action),
            ...(step == null ? {} : { [SAGENT_ATTR.STEP_NUMBER]: step }),
          },
        });
        break;
      }

      case 'approval_result':
      case 'user_response': {
        const key = step == null ? 'run.approval' : `step.${step}.approval`;
        owner = spansByKey.get(key)
          || openSpan(key, {
            name: 'approval',
            parentKey: step == null ? 'run' : `step.${step}`,
            startTimeMs: spanStart,
            attributes: step == null ? {} : { [SAGENT_ATTR.STEP_NUMBER]: step },
          });
        if (event.type === 'approval_result') {
          setAttr(owner.attributes, SAGENT_ATTR.APPROVAL_DECISION, event.decision);
          if (event.decision === 'reject' || event.decision === 'blocked') {
            owner.status = { code: STATUS_CODE.ERROR, message: event.message || undefined };
            setAttr(owner.attributes, ATTR.ERROR_TYPE, event.decision);
          }
        } else {
          setAttr(owner.attributes, SAGENT_ATTR.APPROVAL_DECISION, 'answered');
        }
        closeSpan(key, ts);
        break;
      }

      case 'terminal_output':
      case 'mcp_output': {
        // 工具的过程输出不值得各开一个 span（一条命令能刷出上百条），
        // 作为所属 execute span 的 span event 更贴合 OTel 的用法。
        const key = step == null ? 'run' : `step.${step}.execute`;
        owner = spansByKey.get(key)
          || (step == null
            ? ensureRunSpan(spanStart)
            : openSpan(key, {
                name: OPERATION.EXECUTE_TOOL,
                parentKey: `step.${step}`,
                startTimeMs: spanStart,
                attributes: {
                  [ATTR.OPERATION_NAME]: OPERATION.EXECUTE_TOOL,
                  [SAGENT_ATTR.STEP_NUMBER]: step,
                },
              }));
        const attributes: Record<string, SpanAttributeValue> = {};
        setAttr(attributes, 'sagent.output.phase', event.phase);
        setAttr(attributes, 'sagent.output.sequence', Number(event.sequence));
        if (event.type === 'mcp_output') {
          setAttr(attributes, 'sagent.mcp.server', event.serverName);
          setAttr(attributes, 'sagent.mcp.tool', event.toolName);
        }
        setAttr(attributes, 'sagent.terminal.exit_code', Number(event.exitCode));
        owner.events.push({ name: event.type, timeMs: ts, attributes });
        break;
      }

      case 'done': {
        owner = ensureRunSpan(spanStart);
        // finish 动作不产生 result 事件，收尾时统一关掉本步残留的 span。
        closeStalePriorSteps(Number.MAX_SAFE_INTEGER, ts);
        const { input, output } = totalUsage();
        setAttr(owner.attributes, ATTR.USAGE_INPUT_TOKENS, input || undefined);
        setAttr(owner.attributes, ATTR.USAGE_OUTPUT_TOKENS, output || undefined);
        setAttr(owner.attributes, SAGENT_ATTR.RUN_STATUS, event.meta?.status || 'done');
        setAttr(owner.attributes, SAGENT_ATTR.QUALITY_STATUS, (event.quality as any)?.status);
        setAttr(owner.attributes, ATTR.REQUEST_MODEL, runModel);
        setAttr(owner.attributes, SAGENT_ATTR.RUN_STRATEGY, runStrategy);
        owner.status = { code: STATUS_CODE.OK };
        closeSpan('run', ts);
        break;
      }

      case 'error': {
        owner = ensureRunSpan(spanStart);
        closeStalePriorSteps(Number.MAX_SAFE_INTEGER, ts);
        const { input, output } = totalUsage();
        setAttr(owner.attributes, ATTR.USAGE_INPUT_TOKENS, input || undefined);
        setAttr(owner.attributes, ATTR.USAGE_OUTPUT_TOKENS, output || undefined);
        const errorType = errorTypeOf(event.error);
        setAttr(owner.attributes, ATTR.ERROR_TYPE, errorType);
        setAttr(owner.attributes, SAGENT_ATTR.RUN_STATUS, errorType === 'cancelled' ? 'cancelled' : 'failed');
        owner.status = { code: STATUS_CODE.ERROR, message: event.error || undefined };
        closeSpan('run', ts);
        break;
      }

      default: {
        // status / notification / session_checkpoint / rollback：
        // 没有独立时长，作为所属 span 的 span event 记录。
        owner = step == null
          ? ensureRunSpan(spanStart)
          : (spansByKey.get(`step.${step}`) || ensureStepSpan(step, spanStart));
        const attributes: Record<string, SpanAttributeValue> = {};
        setAttr(attributes, 'sagent.notification.level', event?.level);
        setAttr(attributes, 'sagent.status', event?.status);
        owner.events.push({ name: String(event?.type || 'event'), timeMs: ts, attributes });
        break;
      }
    }

    cursorTs = Math.max(cursorTs, ts);
    return { trace_id: traceId, span_id: owner.spanId, parent_id: owner.parentSpanId };
  }

  /**
   * 关闭所有仍打开的 span，返回全部已完成的 span（按创建顺序）。可重复调用。
   * 剥掉内部用的 key 字段，只暴露 AssembledSpan。
   */
  function flush(): AssembledSpan[] {
    // 先关子后关根：run 是唯一的根，放到最后。
    for (const key of [...openKeys].filter(key => key !== 'run')) {
      closeSpan(key, cursorTs);
    }
    closeSpan('run', cursorTs);
    return completed.map(({ key: _key, ...span }) => span);
  }

  return { consume, flush, traceId, sessionId: resolvedSessionId };
}

export type SpanAssembler = ReturnType<typeof createSpanAssembler>;
