export type ConfigValueType = 'int' | 'bool';
export type ConfigGroup = 'execution' | 'context' | 'memory' | 'routing';

export interface RuntimeConfig {
  maxSteps: number;
  modelTimeoutSec: number;
  maxOutputTokens: number;
  staggerDelaySec: number;
  batchSize: number;
  observeDesktop: boolean;
  maxHistorySteps: number;
  maxResultChars: number;
  autoModelRouting: boolean;
}

export type RuntimeConfigKey = keyof RuntimeConfig;

export type ConfigProfile = 'fast' | 'balanced' | 'deep' | 'safe' | 'custom';

export type McpTransportConfig =
  | { type: 'sse'; url: string; messagesUrl?: string }
  | { type: 'http'; url: string }
  | { type: 'stdio'; command: string; args?: string[]; cwd?: string };

export interface McpServerConfig {
  enabled: boolean;
  transport: McpTransportConfig;
  promptMode?: 'lazy' | 'always';
  keepOpen?: boolean;
  keepTabs?: boolean;
  toolTimeoutMs?: number;
  navigateTimeoutMs?: number;
}

export interface SagentConfigDocument {
  version: 1;
  profile?: ConfigProfile;
  agent?: Partial<RuntimeConfig>;
  mcpServers?: Record<string, McpServerConfig>;
  tools?: {
    vision?: { model?: string };
    distill?: { model?: string };
    screenshots?: {
      redaction?: 'pixelate' | 'none';
      retention?: { enabled?: boolean; maxAgeDays?: number; maxTotalMB?: number };
    };
  };
  execution?: {
    sandboxedWorkers?: boolean;
    workerSandbox?: boolean;
  };
}

export type ConfigFieldSpec = {
  type: ConfigValueType;
  default: number | boolean;
  min?: number;
  max?: number;
  group: ConfigGroup;
  advanced: boolean;
  restartRequired: boolean;
};

export const AGENT_CONFIG_SCHEMA: Record<RuntimeConfigKey, ConfigFieldSpec> = {
  maxSteps: { type: 'int', default: 8, min: 1, max: 512, group: 'execution', advanced: false, restartRequired: false },
  modelTimeoutSec: { type: 'int', default: 90, min: 1, max: 3600, group: 'execution', advanced: false, restartRequired: false },
  maxOutputTokens: { type: 'int', default: 4096, min: 128, max: 65536, group: 'execution', advanced: true, restartRequired: false },
  staggerDelaySec: { type: 'int', default: 5, min: 0, max: 120, group: 'routing', advanced: true, restartRequired: false },
  batchSize: { type: 'int', default: 1, min: 1, max: 32, group: 'routing', advanced: true, restartRequired: false },
  observeDesktop: { type: 'bool', default: false, group: 'execution', advanced: true, restartRequired: false },
  maxHistorySteps: { type: 'int', default: 6, min: 1, max: 200, group: 'context', advanced: true, restartRequired: false },
  maxResultChars: { type: 'int', default: 4000, min: 100, max: 200000, group: 'context', advanced: true, restartRequired: false },
  autoModelRouting: { type: 'bool', default: false, group: 'routing', advanced: false, restartRequired: false },
};

export const AGENT_CONFIG_KEYS = Object.keys(AGENT_CONFIG_SCHEMA) as RuntimeConfigKey[];

export const CONFIG_PROFILES: Record<Exclude<ConfigProfile, 'custom'>, Partial<RuntimeConfig>> = {
  fast: {
    maxSteps: 6,
    modelTimeoutSec: 60,
    maxOutputTokens: 2048,
    maxHistorySteps: 4,
    maxResultChars: 2500,
    batchSize: 1,
    staggerDelaySec: 0,
    autoModelRouting: false,
  },
  balanced: {
    maxSteps: 8,
    modelTimeoutSec: 90,
    maxOutputTokens: 4096,
    maxHistorySteps: 6,
    maxResultChars: 4000,
    batchSize: 1,
    staggerDelaySec: 5,
    autoModelRouting: false,
  },
  deep: {
    maxSteps: 32,
    modelTimeoutSec: 240,
    maxOutputTokens: 8192,
    maxHistorySteps: 12,
    maxResultChars: 8000,
    batchSize: 2,
    staggerDelaySec: 1,
    autoModelRouting: true,
  },
  safe: {
    maxSteps: 8,
    modelTimeoutSec: 120,
    maxOutputTokens: 4096,
    maxHistorySteps: 6,
    maxResultChars: 4000,
    batchSize: 1,
    staggerDelaySec: 5,
    observeDesktop: false,
    autoModelRouting: false,
  },
};

// Agent 运行时参数只从内置默认 + data/config.json 解析，不再读取环境变量。
export function configDefaults(): {
  values: RuntimeConfig;
  sources: Record<RuntimeConfigKey, 'default'>;
} {
  const values = {} as RuntimeConfig;
  const sources = {} as Record<RuntimeConfigKey, 'default'>;

  for (const key of AGENT_CONFIG_KEYS) {
    (values as any)[key] = AGENT_CONFIG_SCHEMA[key].default;
    sources[key] = 'default';
  }

  return { values, sources };
}
