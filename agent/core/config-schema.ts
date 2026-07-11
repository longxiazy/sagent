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
  maxParallelResultChars: number;
  memoryMaxEntries: number;
  autoModelRouting: boolean;
}

export type RuntimeConfigKey = keyof RuntimeConfig;

export type ConfigProfile = 'fast' | 'balanced' | 'deep' | 'safe' | 'custom';

export type McpTransportConfig =
  | { type: 'sse'; url: string; messagesUrl?: string }
  | { type: 'stdio'; command: string; args?: string[]; cwd?: string };

export interface McpServerConfig {
  enabled: boolean;
  transport: McpTransportConfig;
  projectPath?: string;
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
    screenshots?: { redaction?: 'pixelate' | 'none' };
  };
  execution?: {
    resume?: boolean;
    sandboxedWorkers?: boolean;
    workerSandbox?: boolean;
  };
}

export type ConfigFieldSpec = {
  env: string;
  type: ConfigValueType;
  default: number | boolean;
  min?: number;
  max?: number;
  group: ConfigGroup;
  advanced: boolean;
  restartRequired: boolean;
};

export const AGENT_CONFIG_SCHEMA: Record<RuntimeConfigKey, ConfigFieldSpec> = {
  maxSteps: { env: 'AGENT_MAX_STEPS', type: 'int', default: 8, min: 1, max: 512, group: 'execution', advanced: false, restartRequired: false },
  modelTimeoutSec: { env: 'AGENT_MODEL_TIMEOUT', type: 'int', default: 90, min: 1, max: 3600, group: 'execution', advanced: false, restartRequired: false },
  maxOutputTokens: { env: 'AGENT_MAX_OUTPUT_TOKENS', type: 'int', default: 4096, min: 128, max: 65536, group: 'execution', advanced: true, restartRequired: false },
  staggerDelaySec: { env: 'AGENT_STAGGER_DELAY', type: 'int', default: 5, min: 0, max: 120, group: 'routing', advanced: true, restartRequired: false },
  batchSize: { env: 'AGENT_BATCH_SIZE', type: 'int', default: 1, min: 1, max: 32, group: 'routing', advanced: true, restartRequired: false },
  observeDesktop: { env: 'AGENT_OBSERVE_DESKTOP', type: 'bool', default: false, group: 'execution', advanced: true, restartRequired: false },
  maxHistorySteps: { env: 'AGENT_MAX_HISTORY_STEPS', type: 'int', default: 6, min: 1, max: 200, group: 'context', advanced: true, restartRequired: false },
  maxResultChars: { env: 'AGENT_MAX_RESULT_CHARS', type: 'int', default: 4000, min: 100, max: 200000, group: 'context', advanced: true, restartRequired: false },
  maxParallelResultChars: { env: 'AGENT_MAX_PARALLEL_RESULT_CHARS', type: 'int', default: 32000, min: 100, max: 1000000, group: 'context', advanced: true, restartRequired: false },
  memoryMaxEntries: { env: 'AGENT_MEMORY_MAX_ENTRIES', type: 'int', default: 20, min: 1, max: 1000, group: 'memory', advanced: false, restartRequired: false },
  autoModelRouting: { env: 'AGENT_AUTO_MODEL_ROUTING', type: 'bool', default: false, group: 'routing', advanced: false, restartRequired: false },
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

export function configDefaultsFromEnv(env: Record<string, string | undefined> = process.env): {
  values: RuntimeConfig;
  sources: Record<RuntimeConfigKey, 'default' | 'env'>;
} {
  const values = {} as RuntimeConfig;
  const sources = {} as Record<RuntimeConfigKey, 'default' | 'env'>;

  for (const key of AGENT_CONFIG_KEYS) {
    const spec = AGENT_CONFIG_SCHEMA[key];
    const raw = env[spec.env];
    let value = spec.default;
    let source: 'default' | 'env' = 'default';
    if (raw != null && String(raw).trim() !== '') {
      if (spec.type === 'bool') {
        value = String(raw).trim().toLowerCase() === 'true';
        source = 'env';
      } else {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && Number.isInteger(parsed)
          && (spec.min == null || parsed >= spec.min)
          && (spec.max == null || parsed <= spec.max)) {
          value = parsed;
          source = 'env';
        }
      }
    }
    (values as any)[key] = value;
    sources[key] = source;
  }

  return { values, sources };
}
