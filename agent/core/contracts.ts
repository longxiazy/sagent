/**
 * Agent 内部核心契约。
 *
 * 外部模型/SDK 的未知数据应在 adapter/schema 边界被校验，进入 runtime 后只使用
 * 这里定义的归一化 Action、Event、Step 和 Run 类型。
 */

export type JsonObject = Record<string, unknown>;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  output_tokens?: number;
  total_tokens?: number;
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
  | { tool: 'browser'; type: 'parallel_fetch'; urls: string[]; extractLinks: boolean };

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

export type MacOSAction =
  | { tool: 'macos'; type: 'open_app' | 'activate_app'; app: string }
  | { tool: 'macos'; type: 'list_windows' | 'capture_screen' }
  | { tool: 'macos'; type: 'type_text'; text: string }
  | { tool: 'macos'; type: 'press_key'; key: string; modifiers: string[] }
  | { tool: 'macos'; type: 'click_at'; x: number; y: number };

export type IdeAction =
  | { tool: 'ide'; type: 'ide_list_tools'; refresh: boolean }
  | { tool: 'ide'; type: 'ide_call_tool'; toolName: string; arguments: JsonObject; refreshTools: boolean };

export type ChromeAction =
  | { tool: 'chrome'; type: 'chrome_list_tools'; refresh: boolean }
  | { tool: 'chrome'; type: 'chrome_call_tool'; toolName: string; arguments: JsonObject; refreshTools: boolean };

export type AgentAction =
  | CoreAction
  | BrowserAction
  | FsAction
  | TerminalAction
  | MacOSAction
  | IdeAction
  | ChromeAction
  | { tool: 'search'; type: 'web_search'; query: string; maxResults: number }
  | { tool: 'codegraph'; type: 'codegraph_query'; query: string }
  | { tool: 'vision'; type: 'image_analyze'; image: string; question: string }
  | { tool: 'spawn'; type: 'spawn'; tasks: string[] };

export type AgentTool = AgentAction['tool'];
export type ActionForTool<T extends AgentTool> = Extract<AgentAction, { tool: T }>;

export interface AgentDecision {
  rationale: string;
  action: AgentAction;
  usage?: TokenUsage | null;
  reasoning?: string | null;
  model?: string;
  consensus?: JsonObject;
}

export type ActionResultStatus = 'success' | 'failed' | 'rejected';

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

interface EventTraceFields {
  runId?: string;
  timestamp?: number;
  trace_id?: string;
  span_id?: string;
  parent_id?: string;
  operation?: string;
  start_time?: number;
  end_time?: number;
  duration_ms?: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  usage?: TokenUsage | null;
}

export type AgentEvent = EventTraceFields & (
  | { type: 'status'; status: string; message?: string }
  | { type: 'run_meta'; startedAt: number; model?: string; agentModels?: string[]; task?: string }
  | { type: 'step'; step: number; stage: 'observe'; observation: unknown }
  | { type: 'step'; step: number; stage: 'action'; rationale?: string; action: AgentAction; usage?: TokenUsage | null }
  | { type: 'step'; step: number; stage: 'result'; result: unknown; resultStatus?: ActionResultStatus; resultError?: string | null }
  | { type: 'model_plan'; stage: 'start' | 'thinking' | 'success' | 'winner' | 'failed' | 'cancelled' | 'pending' | 'rate_limited' | 'consensus'; step?: number; model?: string; models?: string[]; action?: AgentAction; rationale?: string; reasoning?: string | null; usage?: TokenUsage | null; error?: string; delay?: number; cooldown_ms?: number; routing?: unknown; consensus?: unknown }
  | { type: 'terminal_output'; step?: number; phase: 'start' | 'stdout' | 'stderr' | 'exit' | 'error' | 'timeout'; command?: string; cwd?: string; sequence?: number; chunk?: string; exitCode?: number | null; elapsedMs?: number; message?: string }
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
  projectId?: string | null;
  dataDir?: string;
  projectRoot?: string | null;
  [key: string]: unknown;
}

export interface WorkerControl {
  cancel?: () => void;
  rollback?: (targetStep: number) => void;
}

export interface RunRecord {
  runId: string;
  startedAt: number;
  cancelAc: AbortController;
  events: AgentEvent[];
  status: RunStatus;
  meta: RunMeta;
  traceWrites?: Promise<unknown>[];
  _reconnectWriters?: AgentEventWriter[] | null;
  pendingRollback?: number | null;
  rolledBack?: boolean;
  workerControl?: WorkerControl | null;
  cleanupTimer?: NodeJS.Timeout;
}

export interface AgentRunStore {
  createRun(meta?: RunMeta, startedAt?: number, existingRunId?: string): RunRecord;
  getRun(runId: string): RunRecord | null;
  getActiveRun(): RunRecord | null;
  getActiveRuns(): RunRecord[];
  getRunningRuns(): RunRecord[];
  addEvent(runId: string, event: AgentEvent): void;
  transitionRun(runId: string, nextStatus: RunStatus): RunRecord | null;
  cancelRun(runId: string): RunRecord | null;
  closeRun(runId: string, outcome?: TerminalRunStatus): RunRecord | null;
}

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
  resolve(approvalId: string, decision: string): ApprovalPayload;
  listPendingForRun(runId: string): PendingApproval[];
  getPendingForRun(runId: string): PendingApproval | null;
  rejectAll(): void;
}

export interface DomainRules {
  needsBrowser(url: string): Promise<boolean>;
  markBrowserDomain(url: string): Promise<void>;
  detectBotResponse(content: unknown): Promise<boolean>;
  getRules(): Promise<string[]>;
  addDomain(domain: string): Promise<void>;
  removeDomain(domain: string): Promise<void>;
  resetToDefaults(): Promise<void>;
}

export interface AgentRuntimeState {
  runId?: string;
  onEvent?: AgentEventWriter;
  headless?: boolean;
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
  onCheckpoint?: ((history: AgentStep[], step: number) => unknown | Promise<unknown>) | null;
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

export type AgentAuthorization =
  | { status: 'approved'; response?: string }
  | { status: 'rejected'; message: string; response?: string };

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
    saveCheckpoint(data: unknown): void | Promise<void>;
    saveHealthySnapshot(data: unknown): void | Promise<void>;
  } | null;
}

export interface DesktopAgentRunner {
  (options: DesktopAgentRunOptions): Promise<DesktopAgentResult>;
  domainRules?: DomainRules;
}
