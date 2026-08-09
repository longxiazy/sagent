/**
 * 内容捕获 —— 把 task / 模型输出 / 工具参数与结果放进 span 属性。
 *
 * 默认关闭。OTel GenAI 约定对此的立场很明确：
 *   "Model instructions, user messages, and model outputs are considered
 *    sensitive and are often large in size. Instrumentations SHOULD NOT
 *    capture them by default, but SHOULD provide an option for users to opt in."
 *
 * 两个理由都成立：trace 会离开本机进 collector（隐私），单条页面正文动辄上百 KB
 * （体积——超过 collector 的属性长度上限会被整条丢弃）。所以这里既要显式开启，
 * 又要逐字段截断。
 *
 * 内容进入本模块前已经过 helpers/redact.ts 脱敏（见 run-agent.ts 的调用顺序），
 * 因此凭据不会因为开启本选项而泄漏；但任务正文、页面内容等业务数据会。
 *
 * 消息结构遵循约定里的 input/output messages JSON schema：
 *   [{ role, parts: [{ type: 'text' | 'tool_call' | 'tool_call_response', ... }] }]
 * 规范注明结构化属性在 span 上尚未普遍支持，应序列化为 JSON 字符串——这里就这么做。
 */

import { ATTR, SAGENT_ATTR, type ContentAttributeValue } from './semconv.ts';

/** 单个内容字段的默认上限。超出的部分截断并标注，不丢整条属性。 */
export const DEFAULT_MAX_CONTENT_CHARS = 4_096;

export interface ContentCaptureOptions {
  /** 是否捕获内容。默认 false（遵循约定）。 */
  captureContent?: boolean;
  /** 单个内容字段的字符上限。 */
  maxContentChars?: number;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `${text.slice(0, limit)}…[truncated ${dropped} chars]`;
}

/** 任意值 → 可读文本。对象走 JSON，避免出现 "[object Object]"。 */
function asText(value: unknown, limit: number): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return truncate(String(text ?? ''), limit);
}

/** 结构化值 → JSON 字符串（先截断内部文本，再整体序列化）。 */
function asJson(value: unknown, limit: number): string {
  return truncate(JSON.stringify(value) ?? '', limit * 2);
}

/** 动作里除 tool/type 之外的参数，即工具的实际入参。 */
function toolArguments(action: Record<string, unknown> | null | undefined) {
  if (!action || typeof action !== 'object') return {};
  const { tool: _tool, type: _type, ...args } = action;
  return args;
}

export function createContentCapture({
  captureContent = false,
  maxContentChars = DEFAULT_MAX_CONTENT_CHARS,
}: ContentCaptureOptions = {}) {
  const limit = Number.isFinite(maxContentChars) && maxContentChars > 0
    ? Math.floor(maxContentChars)
    : DEFAULT_MAX_CONTENT_CHARS;

  /** 关闭时所有 set* 都是 no-op，调用方无需到处判断。 */
  const enabled = captureContent === true;

  function set(
    attributes: Record<string, ContentAttributeValue>,
    key: string,
    value: string | undefined,
  ) {
    if (!enabled || !value) return;
    attributes[key] = value;
  }

  return {
    enabled,

    /** run 根 span：用户任务。 */
    setTask(attributes: Record<string, ContentAttributeValue>, task: unknown) {
      const text = asText(task, limit);
      if (!text) return;
      set(attributes, ATTR.INPUT_MESSAGES, asJson(
        [{ role: 'user', parts: [{ type: 'text', content: text }] }],
        limit,
      ));
    },

    /** run 根 span：最终回答。 */
    setAnswer(attributes: Record<string, ContentAttributeValue>, answer: unknown) {
      const text = asText(answer, limit);
      if (!text) return;
      set(attributes, ATTR.OUTPUT_MESSAGES, asJson(
        [{ role: 'assistant', parts: [{ type: 'text', content: text }], finish_reason: 'stop' }],
        limit,
      ));
    },

    /**
     * chat span：模型这一步的产出——推理理由 + 选定的工具调用。
     * 对应 output messages schema 里的 text part 与 tool_call part。
     */
    setDecision(
      attributes: Record<string, ContentAttributeValue>,
      {
        rationale,
        action,
        reasoning,
      }: { rationale?: unknown; action?: Record<string, unknown> | null; reasoning?: unknown },
    ) {
      if (!enabled) return;
      const parts: Array<Record<string, unknown>> = [];
      const rationaleText = asText(rationale, limit);
      if (rationaleText) parts.push({ type: 'text', content: rationaleText });
      if (action && typeof action === 'object') {
        parts.push({
          type: 'tool_call',
          name: `${action.tool || 'core'}.${action.type || 'unknown'}`,
          arguments: JSON.parse(asJson(toolArguments(action), limit)),
        });
      }
      if (parts.length > 0) {
        set(attributes, ATTR.OUTPUT_MESSAGES, asJson(
          [{ role: 'assistant', parts, finish_reason: 'stop' }],
          limit,
        ));
      }
      // 思维链没有对应的 gen_ai 属性，放进私有命名空间。
      set(attributes, SAGENT_ATTR.REASONING, asText(reasoning, limit) || undefined);
    },

    /** execute_tool span：工具入参。 */
    setToolArguments(attributes: Record<string, ContentAttributeValue>, action: Record<string, unknown> | null | undefined) {
      if (!enabled || !action) return;
      const args = toolArguments(action);
      if (Object.keys(args).length === 0) return;
      set(attributes, ATTR.TOOL_CALL_ARGUMENTS, asJson(args, limit));
    },

    /** execute_tool span：工具返回。 */
    setToolResult(attributes: Record<string, ContentAttributeValue>, result: unknown) {
      set(attributes, ATTR.TOOL_CALL_RESULT, asText(result, limit) || undefined);
    },

    /** observe span：环境观察。无对应 gen_ai 属性，走私有命名空间。 */
    setObservation(attributes: Record<string, ContentAttributeValue>, observation: unknown) {
      set(attributes, SAGENT_ATTR.OBSERVATION, asText(observation, limit) || undefined);
    },
  };
}

export type ContentCapture = ReturnType<typeof createContentCapture>;
