/**
 * Agent 内部核心契约。
 *
 * 外部模型/SDK 的未知数据应在 adapter/schema 边界被校验，进入 runtime 后只使用
 * 这里定义的归一化 Action、Event、Step 和 Run 类型。
 */

export type JsonObject = Record<string, unknown>;

/** 模型用量统计（OpenAI 兼容命名，部分供应商只有前两项）。 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: JsonObject | null;
  completion_tokens_details?: JsonObject | null;
}

export type CoreAction =
  | { tool: 'core'; type: 'finish'; answer: string }
  | { tool: 'core'; type: 'ask_user'; question: string }
  | { tool: 'core'; type: 'notify_user'; message: string; level: 'info' | 'warning' | 'discovery' };

export type BrowserAction =
  | { tool: 'browser'; type: 'navigate'; url: string }
  | { tool: 'browser'; type: 'click'; elementId: string }
  | { tool: 'browser'; type: 'type'; elementId: string; text: string; submit: boolean }
  | { tool: 'browser'; type: 'wait'; seconds: number }
  | { tool: 'browser'; type: 'scroll'; direction: 'up' | 'down'; amount: number }
  | { tool: 'browser'; type: 'get_page_content' }
  | { tool: 'browser'; type: 'http_fetch'; url: string; extractLinks: boolean }

export type FsAction =
  | { tool: 'fs'; type: 'list_dir'; path: string }
  | { tool: 'fs'; type: 'get_file_info'; path: string }
  | { tool: 'fs'; type: 'read_file'; path: string; maxBytes: number }
  | { tool: 'fs'; type: 'write_file'; path: string; content: string; append: boolean }
  | { tool: 'fs'; type: 'search_files'; query: string; path: string; include: string; maxResults: number };

export type TerminalAction = {
  tool: 'terminal';
  type: 'run_safe' | 'run_confirmed' | 'run_review';
  command: string;
  cwd: string;
  timeoutMs: number;
};

export type ChromeAction =
  | { tool: 'chrome'; type: 'chrome_list_tools'; refresh: boolean }
  | { tool: 'chrome'; type: 'chrome_call_tool'; toolName: string; arguments: JsonObject; refreshTools: boolean };

export type McpAction =
  | { tool: 'mcp'; type: 'mcp_list_servers' }
  | { tool: 'mcp'; type: 'mcp_list_tools'; serverName: string; refresh: boolean }
  | { tool: 'mcp'; type: 'mcp_call_tool'; serverName: string; toolName: string; arguments: JsonObject; refreshTools: boolean };

export type AgentAction =
  | CoreAction
  | BrowserAction
  | FsAction
  | TerminalAction
  | ChromeAction
  | McpAction
  | { tool: 'search'; type: 'web_search'; query: string; maxResults: number }
  | { tool: 'vision'; type: 'image_analyze'; image: string; question: string };

export type AgentTool = AgentAction['tool'];
export type ActionForTool<T extends AgentTool> = Extract<AgentAction, { tool: T }>;

/** 模型单步决策：理由 + 归一化动作（+ 用量/推理内容）。 */
export interface AgentDecision {
  rationale: string;
  action: AgentAction;
  usage?: TokenUsage | null;
  reasoning?: string | null;
  model?: string;
  consensus?: JsonObject;
}

/** 动作执行结果状态：成功 / 失败 / 被拒绝。 */
export type ActionResultStatus = 'success' | 'failed' | 'rejected';

/** 单步记录：决策 + 执行结果，构成回滚/历史/快照的最小单元。 */
export interface AgentStep {
  step: number;
  rationale: string;
  action: AgentAction;
  result: unknown;
  resultStatus?: ActionResultStatus;
  resultError?: string | null;
  url?: string;
  title?: string;
  observation?: JsonObject;
}

export type AgentObservation = JsonObject;

/**
 * SSE 事件的公共追踪字段（可选，trace/用量）。
 *
 * trace_id / span_id / parent_id 是 W3C Trace Context 合规值（32/16 位小写 hex），
 * 由 helpers/telemetry/ 的哈希函数确定性派生：
 *   trace_id ← sessionId（同一 chat session 的多次 run 共享，各自是一个根 span）
 *   span_id  ← runId + attempt + span 路径
 * 因此写 JSONL 时与离线重放时算出的 span 树完全一致，可直接转 OTLP
 * 供 Jaeger / Zipkin 消费（见 scripts/trace-to-otlp.ts）。
 */
interface EventTraceFields {
  seq?: number;
  runId?: string;
  attempt?: number;
  timestamp?: number;
  trace_id?: string;
  span_id?: string;
  parent_id?: string;
  start_time?: number;
  end_time?: number;
  duration_ms?: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  usage?: TokenUsage | null;
}

export type AgentEvent = EventTraceFields & (
  | { type: 'status'; status: string; message?: string }
  | { type: 'run_meta'; startedAt: number; model?: string; agentModels?: string[]; task?: string; sessionId?: string; projectId?: string | null; strategy?: string; privateMode?: boolean }
  | { type: 'step'; step: number; stage: 'observe'; observation: unknown }
  | { type: 'step'; step: number; stage: 'action'; rationale?: string; action: AgentAction; usage?: TokenUsage | null }
  | { type: 'step'; step: number; stage: 'result'; result: unknown; resultStatus?: ActionResultStatus; resultError?: string | null }
  | { type: 'model_plan'; stage: 'start' | 'thinking' | 'success' | 'winner' | 'failed' | 'cancelled' | 'pending' | 'rate_limited' | 'consensus'; step?: number; model?: string; models?: string[]; action?: AgentAction; rationale?: string; reasoning?: string | null; response?: unknown; usage?: TokenUsage | null; requests?: unknown[][]; error?: string; delay?: number; cooldown_ms?: number; routing?: unknown; consensus?: unknown }
  | { type: 'terminal_output'; step?: number; phase: 'start' | 'stdout' | 'stderr' | 'exit' | 'error' | 'timeout'; command?: string; cwd?: string; sequence?: number; chunk?: string; exitCode?: number | null; elapsedMs?: number; message?: string }
  | { type: 'mcp_output'; step?: number; phase: 'connecting' | 'connected' | 'discovering' | 'calling' | 'waiting' | 'progress' | 'completed' | 'error'; serverName: string; toolName?: string; sequence?: number; message?: string; progress?: number; total?: number }
  | { type: 'session_checkpoint'; step: number; message: string }
  | { type: 'rollback'; targetStep: number; message: string }
  | { type: 'notification'; level: 'info' | 'warning' | 'discovery'; step?: number; message: string }
  | { type: 'approval_required' | 'question_required'; approvalId: string; step?: number; action: AgentAction; message?: string }
  | { type: 'approval_result'; approvalId?: string; step?: number; decision: 'approve' | 'reject' | 'blocked'; action: AgentAction; message: string }
  | { type: 'user_response'; approvalId: string; step?: number; question: string; response: string }
  | { type: 'done'; answer: string; steps?: AgentStep[]; quality?: unknown; meta?: JsonObject }
  | { type: 'error'; error: string; rollbackSuggestion?: unknown }
);

export type AgentEventWriter = (event: AgentEvent) => void;

/** 运行生命周期状态。 */
export type RunStatus =
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ActiveRunStatus = Extract<RunStatus, 'starting' | 'running' | 'waiting_approval' | 'cancelling'>;
export type TerminalRunStatus = Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>;

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'starting',
  'running',
  'waiting_approval',
  'cancelling',
]);

/** 状态机的合法迁移表；非法迁移在 transitionRun 中被拒绝。 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  starting: new Set(['running', 'cancelling', 'failed']),
  running: new Set(['waiting_approval', 'cancelling', 'completed', 'failed']),
  waiting_approval: new Set(['running', 'cancelling', 'failed']),
  cancelling: new Set(['cancelled', 'failed']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export interface RunMeta {
  model?: string;
  agentModels?: string[];
  task?: string;
  attempt?: number;
  privateMode?: boolean;
  projectId?: string | null;
  dataDir?: string;
  projectRoot?: string | null;
  [key: string]: unknown;
}

export interface WorkerControl {
  cancel?: () => void;
  rollback?: (targetStep: number) => void;
}

/** 运行期记录：run 状态、事件流、取消句柄，及 worker/rollback 桥接。 */
export interface RunRecord {
  runId: string;
  startedAt: number;
  cancelAc: AbortController;
  events: AgentEvent[];
  status: RunStatus;
  meta: RunMeta;
  nextEventSeq: number;
  persistence?: {
    enqueue<T>(task: () => T | Promise<T>): Promise<T>;
    flush(): Promise<void>;
  };
  _reconnectWriters?: AgentEventWriter[] | null;
  pendingRollback?: number | null;
  rolledBack?: boolean;
  workerControl?: WorkerControl | null;
  cleanupTimer?: NodeJS.Timeout;
}

/** 单例运行仓库接口：创建/查询/迁移状态/追加事件/取消与关闭。 */
export interface AgentRunStore {
  createRun(meta?: RunMeta, startedAt?: number, existingRunId?: string, initialEventSeq?: number): RunRecord;
  tryCreateRun(meta?: RunMeta, startedAt?: number, existingRunId?: string, initialEventSeq?: number):
    | { ok: true; run: RunRecord }
    | { ok: false; activeRun: RunRecord };
  getRun(runId: string): RunRecord | null;
  getActiveRun(): RunRecord | null;
  getActiveRuns(): RunRecord[];
  getRunningRuns(): RunRecord[];
  addEvent(runId: string, event: AgentEvent): AgentEvent;
  transitionRun(runId: string, nextStatus: RunStatus): RunRecord | null;
  cancelRun(runId: string): RunRecord | null;
  closeRun(runId: string, outcome?: TerminalRunStatus): RunRecord | null;
}

/** 审批请求载荷：类型（审批/提问）+ 所属 run + 触发动作。 */
export interface ApprovalPayload {
  type: 'approval_required' | 'question_required';
  runId: string;
  step?: number;
  action: AgentAction;
  message?: string;
}

export interface PendingApproval extends ApprovalPayload {
  approvalId: string;
}

export interface ApprovalStore {
  request(payload: ApprovalPayload, requestedApprovalId?: string): { approvalId: string; promise: Promise<string> };
  resolve(approvalId: string, decision: string, expectedRunId: string): ApprovalPayload;
  listPendingForRun(runId: string): PendingApproval[];
  getPendingForRun(runId: string): PendingApproval | null;
  rejectAll(): void;
}

/** 步骤循环可见的运行时状态（观察/取消/配置的载体，运行时内任意扩展）。 */
export interface AgentRuntimeState {
  runId?: string;
  onEvent?: AgentEventWriter;
  headless?: boolean;
  privateMode?: boolean;
  browserSession?: {
    view?: { navigate(url: string): Promise<unknown>; [key: string]: unknown };
    [key: string]: unknown;
  } | null;
  observeDesktop?: boolean;
  model?: string;
  agentModels?: string[];
  strategy?: string;
  systemPrompt?: string | null;
  cancelSignal?: AbortSignal;
  projectRoot?: string | null;
  dataDir?: string | null;
  [key: string]: unknown;
}

export interface RuntimeStepContext {
  task: string;
  step: number;
  history: AgentStep[];
}

export interface RuntimeDecisionContext extends RuntimeStepContext {
  observation: AgentObservation;
  state: AgentRuntimeState;
  finalOnly?: boolean;
}

export interface RunAgentRuntimeOptions {
  task: string;
  maxSteps?: number;
  onEvent?: AgentEventWriter | null;
  cancelSignal?: AbortSignal | null;
  initialize: (context: { task: string; onEvent?: AgentEventWriter | null }) => AgentRuntimeState | Promise<AgentRuntimeState>;
  observe: (state: AgentRuntimeState, context: RuntimeStepContext) => AgentObservation | Promise<AgentObservation>;
  decide: (context: RuntimeDecisionContext) => AgentDecision | Promise<AgentDecision>;
  authorize?: ((state: AgentRuntimeState, action: AgentAction, context: AgentExecutionContext) => AgentAuthorization | Promise<AgentAuthorization>) | null;
  execute: (state: AgentRuntimeState, action: AgentAction, context: AgentExecutionContext) => unknown | Promise<unknown>;
  cleanup?: ((state: AgentRuntimeState) => void | Promise<void>) | null;
  shouldObserve?: ((lastAction: AgentAction) => boolean) | null;
  initialStep?: number;
  initialHistory?: AgentStep[];
  saveSessionSnapshot?: ((data: unknown) => unknown | Promise<unknown>) | null;
  sessionCheckpointDir?: string | null;
  runRecord?: Pick<RunRecord, 'runId' | 'pendingRollback' | 'rolledBack'> | null;
}

export interface AgentExecutionContext {
  task: string;
  step: number;
  history: AgentStep[];
  observation: AgentObservation;
  authorization?: AgentAuthorization;
  rationale?: string;
}

/** 审批/授权结论：批准（可带回应）或拒绝（带原因）。 */
export type AgentAuthorization =
  | { status: 'approved'; response?: string }
  | { status: 'rejected'; message: string; response?: string };

/** 按工具分组注册执行器的映射（runtime 步骤循环按 action.tool 分发）。 */
export type ActionHandlerMap<State extends AgentRuntimeState = AgentRuntimeState> = {
  [Tool in AgentTool]?: (
    state: State,
    action: ActionForTool<Tool>,
    context: AgentExecutionContext,
  ) => unknown | Promise<unknown>;
};

export interface DesktopAgentResult {
  answer: string;
  steps: AgentStep[];
  quality?: ResultQuality;
}

export interface ResultQuality {
  status: 'done' | 'done_unverified' | 'done_degraded';
  requires_verified_sources: boolean;
  official_source_steps: number[];
  failure_steps: number[];
  unverified: boolean;
  browse_intent_without_observation: boolean;
  degraded: boolean;
  reasons: string[];
}

export interface DesktopAgentRunOptions {
  task: string;
  model: string;
  models?: string[];
  strategy?: string;
  systemPrompt?: string | null;
  headless?: boolean;
  privateMode?: boolean;
  onEvent?: AgentEventWriter;
  cancelSignal?: AbortSignal;
  runId: string;
  runRecord?: RunRecord | null;
  startedAt?: number;
  initialStep?: number;
  initialHistory?: AgentStep[];
  conversationHistory?: Array<{ role: string; content: string }>;
  memory?: boolean;
  projectRoot?: string | null;
  dataDir?: string | null;
  checkpointWriter?: {
    saveHealthySnapshot(data: unknown): void | Promise<void>;
  } | null;
}

export interface DesktopAgentRunner {
  (options: DesktopAgentRunOptions): Promise<DesktopAgentResult>;
}
