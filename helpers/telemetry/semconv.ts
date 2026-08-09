/**
 * OpenTelemetry 语义约定常量 —— GenAI span 的属性名与取值。
 *
 * 属性名集中在这里，是为了让「跟随约定版本升级」变成改一个文件的事：
 * GenAI 约定仍是 Development 状态，属性名还在演进（例如 gen_ai.system 已被
 * gen_ai.provider.name 取代）。业务代码只引用这里的常量，不写字面量。
 *
 * 参考：
 *   - OTel GenAI spans      https://github.com/open-telemetry/semantic-conventions-genai
 *   - OTel Trace 通用约定    https://opentelemetry.io/docs/specs/semconv/
 *
 * sagent.* 是本项目私有的扩展属性。OTel 允许自定义属性，但**不得**混进 gen_ai.
 * 命名空间——那是规范保留的，自造同名属性会与将来的官方定义冲突。
 */

/** gen_ai.operation.name 的取值。sagent 只用到这三种。 */
export const OPERATION = {
  /** 一次完整的 agent 运行（run 根 span）。 */
  INVOKE_AGENT: 'invoke_agent',
  /** 一次模型推理调用。 */
  CHAT: 'chat',
  /** 一次工具执行。 */
  EXECUTE_TOOL: 'execute_tool',
} as const;

/** OTel 标准属性名。 */
export const ATTR = {
  // —— GenAI 通用 ——
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',

  // —— Agent ——
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',

  // —— Tool ——
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_TYPE: 'gen_ai.tool.type',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',

  // —— 错误（stable，非 GenAI 专属）——
  ERROR_TYPE: 'error.type',

  // —— 资源 ——
  SERVICE_NAME: 'service.name',
  SERVICE_VERSION: 'service.version',
} as const;

/** sagent 私有扩展属性。刻意不用 gen_ai. 前缀。 */
export const SAGENT_ATTR = {
  RUN_ID: 'sagent.run.id',
  RUN_ATTEMPT: 'sagent.run.attempt',
  RUN_STRATEGY: 'sagent.run.strategy',
  RUN_STATUS: 'sagent.run.status',
  RUN_PRIVATE: 'sagent.run.private_mode',
  PROJECT_ID: 'sagent.project.id',
  STEP_NUMBER: 'sagent.step.number',
  STEP_STAGE: 'sagent.step.stage',
  ACTION_TOOL: 'sagent.action.tool',
  ACTION_TYPE: 'sagent.action.type',
  RESULT_STATUS: 'sagent.result.status',
  PLAN_STAGE: 'sagent.plan.stage',
  APPROVAL_DECISION: 'sagent.approval.decision',
  QUALITY_STATUS: 'sagent.quality.status',
} as const;

/** Agent 名。span 名形如 `invoke_agent sagent`，也用作 service.name。 */
export const AGENT_NAME = 'sagent';

/** OTLP 里标识「谁产生了这些 span」的 instrumentation scope。 */
export const SCOPE = {
  name: 'sagent.telemetry.trace-export',
  version: '1',
} as const;

/**
 * SpanKind 枚举值。OTLP/JSON 要求枚举编码为整数，不能用名字字符串
 * （见 opentelemetry-proto specification.md 的 JSON Protobuf Encoding 一节）。
 */
export const SPAN_KIND = {
  INTERNAL: 1,
  CLIENT: 3,
} as const;

/** Span status code 枚举值，同样必须是整数。 */
export const STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

/**
 * 从模型 ID 推断 provider 名，作为 gen_ai.provider.name。
 *
 * sagent 的模型 ID 形如 `nvidia/nemotron-3-ultra-550b-a55b` 或 `gemini-2.5-flash`。
 * 带斜杠时取前缀；gemini-* 归到 OTel 约定里的 `gcp.gen_ai`；其余回退 openai
 * —— 因为它们都经由 OpenAI 兼容端点访问，遥测格式也是 OpenAI 那一套。
 */
export function providerNameFromModel(model: string | undefined | null): string {
  const id = String(model ?? '').trim();
  if (!id) return 'openai';
  if (id.startsWith('gemini') || id.startsWith('models/gemini')) return 'gcp.gen_ai';
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : 'openai';
}

/** 工具动作 → gen_ai.tool.name，形如 `fs.read_file`。 */
export function toolNameFromAction(action: { tool?: string; type?: string } | null | undefined): string {
  const tool = String(action?.tool || 'core');
  const type = String(action?.type || 'unknown');
  return `${tool}.${type}`;
}
