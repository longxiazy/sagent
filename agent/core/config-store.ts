/**
 * Config Store — 集中的结构化配置仓库（单一数据源 + 落盘）
 *
 * 把原先散落在 server.ts / runtime.ts / memory.ts 里、启动时从 process.env
 * 冻结的 Agent 行为参数收敛到这里。消费点改为每次读 get()，因此前台改完
 * 下次 agent 任务即自动生效，无需重启进程。
 *
 * 两类配置的来源不同：
 *   - 热生效 Agent 参数：data/config.json 的 agent 覆盖 > schema 内置默认值，
 *     这些字段不再从环境变量读取。
 *   - 启动期 execution 参数：同一 config.json 的 execution 段保存 Worker 部署选择；
 *     workerSandbox 仍可被环境变量覆盖，sandboxedWorkers 只取存储值。
 *   - config.json 还保存 profile、tools、MCP server；reset() 只清空 Agent 覆盖。
 *
 * get() 是同步的（compressHistory 等热路径是同步函数）；current 在模块加载时
 * 即初始化为默认值，init() 再叠加 json，故任何时刻 get() 都安全。
 *
 * API Key 不在此管理（前台只读展示，仍在 .env 改）。
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../helpers/logger.ts';
import {
  AGENT_CONFIG_KEYS,
  AGENT_CONFIG_SCHEMA,
  CONFIG_PROFILES,
  configDefaults,
  collectConfigWarnings,
  detectProfile,
  type ConfigProfile,
  type RuntimeConfig,
  type RuntimeConfigKey,
  type McpServerConfig,
  type SagentConfigDocument,
} from './config-schema.ts';

export type { RuntimeConfig } from './config-schema.ts';

export type ExecutionConfig = {
  sandboxedWorkers: boolean;
  workerSandbox: boolean;
};

export type ExecutionConfigSource = 'default' | 'user' | 'env';

const EXECUTION_UPDATE_KEYS = ['sandboxedWorkers', 'workerSandbox'] as const;

type ExecutionUpdate = Partial<Pick<ExecutionConfig, typeof EXECUTION_UPDATE_KEYS[number]>>;

function envBool(env: Record<string, string | undefined>, name: string, fallback: boolean) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function hasEnvValue(env: Record<string, string | undefined>, name: string) {
  return env[name] != null && String(env[name]).trim() !== '';
}

function validateExecution(patch: any): { clean: ExecutionUpdate; errors: string[] } {
  const clean: ExecutionUpdate = {};
  const errors: string[] = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { clean, errors: ['启动配置必须是对象'] };
  }
  for (const key of EXECUTION_UPDATE_KEYS) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'boolean') {
      errors.push(`${key} 必须是布尔值`);
      continue;
    }
    clean[key] = patch[key];
  }
  return { clean, errors };
}

/** 纯函数：返回内置默认值。 */
export function computeDefaults(): RuntimeConfig {
  return configDefaults().values;
}

/**
 * 纯函数：校验前台传来的 patch，返回 { clean, errors }。
 * - 只认识 AGENT_CONFIG_SCHEMA 里的键，未知键忽略
 * - int 字段必须是有限整数且在 [min,max]；bool 字段必须是布尔
 * - 任一字段非法记入 errors，且不进入 clean
 */
export function validateConfig(patch: any): { clean: Partial<RuntimeConfig>; errors: string[] } {
  const clean: Partial<RuntimeConfig> = {};
  const errors: string[] = [];
  if (!patch || typeof patch !== 'object') {
    return { clean, errors: ['配置必须是对象'] };
  }
  for (const key of AGENT_CONFIG_KEYS) {
    if (!(key in patch)) continue;
    const spec = AGENT_CONFIG_SCHEMA[key];
    const v = (patch as any)[key];
    if (spec.type === 'bool') {
      if (typeof v !== 'boolean') {
        errors.push(`${key} 必须是布尔值`);
        continue;
      }
      (clean as any)[key] = v;
    } else {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        errors.push(`${key} 必须是整数`);
        continue;
      }
      if (spec.min != null && n < spec.min) {
        errors.push(`${key} 不能小于 ${spec.min}`);
        continue;
      }
      if (spec.max != null && n > spec.max) {
        errors.push(`${key} 不能大于 ${spec.max}`);
        continue;
      }
      (clean as any)[key] = n;
    }
  }
  return { clean, errors };
}

/** 纯函数：默认值 + 覆盖项合并（覆盖项只取已知且非 null/undefined 的键）。 */
export function mergeConfig(defaults: RuntimeConfig, overrides: Partial<RuntimeConfig> | null | undefined): RuntimeConfig {
  const merged = { ...defaults };
  if (overrides && typeof overrides === 'object') {
    for (const key of AGENT_CONFIG_KEYS) {
      if (key in overrides && (overrides as any)[key] != null) {
        (merged as any)[key] = (overrides as any)[key];
      }
    }
  }
  return merged;
}

// ── 单例 ──────────────────────────────────────────────
let defaultsState = configDefaults();
let defaultValues = defaultsState.values;
let overrides: Partial<RuntimeConfig> = {};
let current: RuntimeConfig = { ...defaultValues };
let filePath: string | null = null;
let legacyFilePath: string | null = null;
let document: SagentConfigDocument = { version: 1, agent: {} };
let saveChain: Promise<void> = Promise.resolve();

function recompute() {
  current = mergeConfig(defaultValues, overrides);
}

async function persist() {
  if (!filePath) return;
  const target = filePath;
  const tmp = target + '.tmp';
  document = { ...document, version: 1, agent: overrides };
  await writeFile(tmp, JSON.stringify(document, null, 2));
  await rename(tmp, target);
}

function normalizeMcpServers(value: any): Record<string, McpServerConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const server = raw as any;
    const transport = server.transport;
    const toolTimeoutMs = Number.isFinite(Number(server.toolTimeoutMs))
      ? Math.max(1_000, Math.min(3_600_000, Math.round(Number(server.toolTimeoutMs))))
      : undefined;
    if (!transport || typeof transport !== 'object') continue;
    if (transport.type === 'sse' && typeof transport.url === 'string' && transport.url.trim()) {
      servers[name] = {
        ...server,
        enabled: server.enabled !== false,
        toolTimeoutMs: toolTimeoutMs ?? (name === 'codex' ? 600_000 : undefined),
        transport: {
          type: 'sse',
          url: transport.url.trim(),
          ...(typeof transport.messagesUrl === 'string' && transport.messagesUrl.trim()
            ? { messagesUrl: transport.messagesUrl.trim() }
            : {}),
        },
      };
    } else if (transport.type === 'http' && typeof transport.url === 'string' && transport.url.trim()) {
      servers[name] = {
        ...server,
        enabled: server.enabled !== false,
        toolTimeoutMs: toolTimeoutMs ?? (name === 'codex' ? 600_000 : undefined),
        transport: { type: 'http', url: transport.url.trim() },
      };
    } else if (transport.type === 'stdio' && typeof transport.command === 'string' && transport.command.trim()) {
      servers[name] = {
        ...server,
        enabled: server.enabled !== false,
        toolTimeoutMs: toolTimeoutMs ?? (name === 'codex' ? 600_000 : undefined),
        transport: {
          type: 'stdio',
          command: transport.command.trim(),
          ...(Array.isArray(transport.args) ? { args: transport.args.map(String) } : {}),
          ...(typeof transport.cwd === 'string' && transport.cwd.trim() ? { cwd: transport.cwd.trim() } : {}),
        },
      };
    }
  }
  return servers;
}

type ScreenshotRetention = { enabled?: boolean; maxAgeDays?: number; maxTotalMB?: number };

function normalizeScreenshotRetention(value: any): ScreenshotRetention | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: ScreenshotRetention = {};
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
  const age = Number(value.maxAgeDays);
  if (Number.isFinite(age) && age >= 0) out.maxAgeDays = Math.min(Math.round(age), 3650);
  const mb = Number(value.maxTotalMB);
  if (Number.isFinite(mb) && mb >= 0) out.maxTotalMB = Math.min(Math.round(mb), 1_048_576);
  return Object.keys(out).length ? out : undefined;
}

function normalizeScreenshots(value: any): NonNullable<NonNullable<SagentConfigDocument['tools']>['screenshots']> {
  const out: NonNullable<NonNullable<SagentConfigDocument['tools']>['screenshots']> = {};
  if (['pixelate', 'none'].includes(value?.redaction)) out.redaction = value.redaction;
  const retention = normalizeScreenshotRetention(value?.retention);
  if (retention) out.retention = retention;
  return out;
}

export function normalizeConfigDocument(value: any): SagentConfigDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, agent: {}, mcpServers: {} };
  }
  // 这里的 profile 只用于把档位展开成实际覆盖值（档位「如何生效」），
  // 不作为「当前属于哪个档位」的依据——后者由 configStore.profile() 从生效值反推。
  const profile = ['fast', 'economy', 'deep', 'besteffort', 'custom'].includes(value.profile)
    ? value.profile as ConfigProfile
    : 'custom';
  const agentOverrides = validateConfig(value.agent ?? {}).clean;
  const agent = profile !== 'custom'
    ? { ...CONFIG_PROFILES[profile], ...agentOverrides }
    : agentOverrides;
  return {
    version: 1,
    profile,
    agent,
    mcpServers: normalizeMcpServers(value.mcpServers),
    tools: {
      vision: typeof value.tools?.vision?.model === 'string' && value.tools.vision.model.trim()
        ? { model: value.tools.vision.model.trim() }
        : {},
      distill: typeof value.tools?.distill?.model === 'string' && value.tools.distill.model.trim()
        ? { model: value.tools.distill.model.trim() }
        : {},
      screenshots: normalizeScreenshots(value.tools?.screenshots),
    },
    execution: {
      ...(typeof value.execution?.sandboxedWorkers === 'boolean' ? { sandboxedWorkers: value.execution.sandboxedWorkers } : {}),
      ...(typeof value.execution?.workerSandbox === 'boolean' ? { workerSandbox: value.execution.workerSandbox } : {}),
    },
  } as SagentConfigDocument;
}

export const configStore = {
  /** 启动时调用一次：设定落盘目录并加载 json 覆盖（含 legacy runtime-config.json 迁移）。
   *  当前使用：server.ts、agent/worker/agent-worker.ts、scripts 离线脚本（trace-eval / prompt-benchmark）。 */
  async init(persistDir: string): Promise<RuntimeConfig> {
    defaultsState = configDefaults();
    defaultValues = defaultsState.values;
    filePath = path.join(persistDir, 'config.json');
    legacyFilePath = path.join(persistDir, 'runtime-config.json');
    try {
      const raw = await readFile(filePath, 'utf-8');
      document = normalizeConfigDocument(JSON.parse(raw));
      overrides = document.agent || {};
    } catch {
      try {
        const legacyRaw = await readFile(legacyFilePath, 'utf-8');
        overrides = validateConfig(JSON.parse(legacyRaw)).clean;
        document = { version: 1, agent: overrides, mcpServers: {} };
        await persist();
        log.warn('[Config] 已将 data/runtime-config.json 迁移到 data/config.json');
      } catch {
        overrides = {};
        document = { version: 1, agent: {}, mcpServers: {} };
      }
    }
    recompute();
    return current;
  },

  /** 同步返回当前完整配置（热路径用）。
   *  当前使用：runtime.ts、planner.ts、providers/gemini.ts、tools/mcp 等运行时各处，改完配置无需重启立即生效。 */
  get(): RuntimeConfig {
    return current;
  },

  /** 内置默认值（前端展示「恢复默认」对照用）。 */
  defaults(): RuntimeConfig {
    return { ...defaultValues };
  },

  /** 各字段当前来源（default/user）。
   *  当前使用：routes/agent-config.ts 的 GET /api/config 展示来源标记。 */
  sources(): Record<RuntimeConfigKey, 'default' | 'user'> {
    const sources = { ...defaultsState.sources } as Record<RuntimeConfigKey, 'default' | 'user'>;
    for (const key of AGENT_CONFIG_KEYS) {
      if (key in overrides) sources[key] = 'user';
    }
    return sources;
  },

  schema() {
    return AGENT_CONFIG_SCHEMA;
  },

  profiles() {
    return CONFIG_PROFILES;
  },

  /**
   * 当前生效值所属的档位，由实际取值反推而非读取记录的标签。
   * 这样「从未配置过」会正确归到 economy（生效值即内置默认），
   * 「把参数改回某档位原值」也会自动回到该档位。
   */
  profile(): ConfigProfile {
    return detectProfile(current);
  },

  /** 当前生效值里搭配失效的项。只提示不拦截，见 collectConfigWarnings。 */
  warnings() {
    return collectConfigWarnings(current);
  },

  document(): SagentConfigDocument {
    return JSON.parse(JSON.stringify(document));
  },

  mcpServers(): Record<string, McpServerConfig> {
    return { ...(document.mcpServers || {}) };
  },

  tools() {
    return JSON.parse(JSON.stringify(document.tools || {}));
  },

  execution(env: Record<string, string | undefined> = process.env): ExecutionConfig {
    const stored = document.execution || {};
    return {
      // execution 是启动期部署选择。sandboxedWorkers 只由存储配置决定（默认沙箱），不再接受环境变量覆盖。
      sandboxedWorkers: stored.sandboxedWorkers ?? true,
      workerSandbox: envBool(env, 'AGENT_WORKER_SANDBOX', stored.workerSandbox ?? true),
    };
  },

  /** 各部署项当前来源（default/user/env）。
   *  当前使用：routes/agent-config.ts 的 GET /api/config 展示来源标记。 */
  executionSources(env: Record<string, string | undefined> = process.env): Record<keyof ExecutionConfig, ExecutionConfigSource> {
    const stored = document.execution || {};
    return {
      sandboxedWorkers: stored.sandboxedWorkers != null ? 'user' : 'default',
      workerSandbox: hasEnvValue(env, 'AGENT_WORKER_SANDBOX')
        ? 'env'
        : stored.workerSandbox != null
          ? 'user'
          : 'default',
    };
  },

  /** 更新需要重启后端才能生效的 Worker 部署选项；与 Agent 段共用 config.json。
   *  当前使用：routes/agent-config.ts 的 PUT /api/config/execution。 */
  async updateExecution(patch: any): Promise<ExecutionConfig> {
    const { clean, errors } = validateExecution(patch);
    if (errors.length) throw new Error(errors.join('；'));
    document = {
      ...document,
      execution: { ...(document.execution || {}), ...clean },
    };
    saveChain = saveChain.then(persist).catch(err => log.error('[Config] 保存启动配置失败:', err?.message || err));
    await saveChain;
    return this.execution();
  },

  /** 新增/替换/删除一个 MCP server 配置（server 为 null 即删除），校验后落盘。
   *  当前使用：routes/agent-config.ts 的 PUT/DELETE /api/config/mcp/:name，
   *  以及 tools/mcp/client.ts、chrome/mcp-client.ts 读取运行时连接参数。 */
  async updateMcpServer(name: string, server: McpServerConfig | null): Promise<Record<string, McpServerConfig>> {
    const key = String(name || '').trim();
    if (!key) throw new Error('MCP server 名称不能为空');
    const next = { ...(document.mcpServers || {}) };
    if (server == null) {
      delete next[key];
    } else {
      const normalized = normalizeMcpServers({ [key]: server });
      if (!normalized[key]) throw new Error(`MCP server ${key} 配置无效`);
      next[key] = normalized[key];
    }
    document = { ...document, mcpServers: next };
    saveChain = saveChain.then(persist).catch(err => log.error('[Config] 保存失败:', err?.message || err));
    await saveChain;
    return { ...next };
  },

  /** 更新全局 tools 配置（vision/distill/screenshots），sanitize 后落盘。 */
  async updateTools(tools: SagentConfigDocument['tools']): Promise<SagentConfigDocument['tools']> {
    const sanitized = normalizeConfigDocument({
      ...document,
      tools: { ...(document.tools || {}), ...(tools || {}) },
    }).tools;
    document = { ...document, tools: sanitized };
    saveChain = saveChain.then(persist).catch(err => log.error('[Config] 保存失败:', err?.message || err));
    await saveChain;
    return sanitized;
  },

  /** 校验并合并 patch，落盘后返回最新配置。校验失败抛错（含原因）。
   *  当前使用：routes/agent-config.ts 的 POST /api/config（设置 UI 保存）。 */
  async update(patch: any): Promise<RuntimeConfig> {
    const { clean, errors } = validateConfig(patch);
    if (errors.length) {
      throw new Error(errors.join('；'));
    }
    overrides = { ...overrides, ...clean };
    document = { ...document, profile: 'custom' };
    recompute();
    saveChain = saveChain.then(persist).catch(err => log.error('[RuntimeConfig] 保存失败:', err?.message || err));
    await saveChain;
    return current;
  },

  /** 应用某个预设档位：以档位取值覆盖 Agent 参数，并在 document 中记录 profile 标签。
   *  当前使用：routes/agent-config.ts 的 POST /api/config/profile。 */
  async applyProfile(profile: Exclude<ConfigProfile, 'custom'>): Promise<RuntimeConfig> {
    const values = CONFIG_PROFILES[profile];
    if (!values) throw new Error(`未知配置 profile: ${profile}`);
    overrides = { ...overrides, ...values };
    document = { ...document, profile };
    recompute();
    saveChain = saveChain.then(persist).catch(err => log.error('[Config] 保存失败:', err?.message || err));
    await saveChain;
    return current;
  },

  /** 清空 Agent 覆盖，回到 schema 内置默认；MCP、tools、execution 等其它配置保持不变。
   *  当前使用：routes/agent-config.ts 的 POST /api/config/reset。 */
  async reset(): Promise<RuntimeConfig> {
    overrides = {};
    document = { ...document, profile: 'custom' };
    recompute();
    saveChain = saveChain.then(persist).catch(err => log.error('[Config] 保存失败:', err?.message || err));
    await saveChain;
    return current;
  },
};

export type ConfigStore = typeof configStore;
