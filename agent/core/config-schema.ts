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

export type ConfigProfile = 'fast' | 'economy' | 'deep' | 'besteffort' | 'custom';

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

// 内置默认值与 economy 档保持一致：全新环境未写过 config.json 时生效值即这里的默认，
// 若不对齐任何档位，界面上会显示成「自定义」。改动此处务必同步 CONFIG_PROFILES.economy。
export const AGENT_CONFIG_SCHEMA: Record<RuntimeConfigKey, ConfigFieldSpec> = {
  maxSteps: { type: 'int', default: 8, min: 1, max: 512, group: 'execution', advanced: false, restartRequired: false },
  modelTimeoutSec: { type: 'int', default: 90, min: 1, max: 3600, group: 'execution', advanced: false, restartRequired: false },
  maxOutputTokens: { type: 'int', default: 4096, min: 128, max: 65536, group: 'execution', advanced: true, restartRequired: false },
  staggerDelaySec: { type: 'int', default: 60, min: 0, max: 120, group: 'routing', advanced: true, restartRequired: false },
  batchSize: { type: 'int', default: 1, min: 1, max: 32, group: 'routing', advanced: true, restartRequired: false },
  observeDesktop: { type: 'bool', default: false, group: 'execution', advanced: true, restartRequired: false },
  maxHistorySteps: { type: 'int', default: 8, min: 1, max: 200, group: 'context', advanced: true, restartRequired: false },
  maxResultChars: { type: 'int', default: 4096, min: 100, max: 200000, group: 'context', advanced: true, restartRequired: false },
  autoModelRouting: { type: 'bool', default: false, group: 'routing', advanced: false, restartRequired: false },
};

export const AGENT_CONFIG_KEYS = Object.keys(AGENT_CONFIG_SCHEMA) as RuntimeConfigKey[];

// 反推档位时的匹配顺序。economy 放最前：它与 schema 内置默认完全一致，
// 未配置过的全新环境应当归到它名下，而不是碰巧取值相同的其它档位。
export const PROFILE_MATCH_ORDER = ['economy', 'fast', 'deep', 'besteffort'] as const;

/**
 * 四档预设。各档只声明与内置默认不同的字段，其余继承（见 resolveProfileValues）。
 *
 * 三条贯穿各档的约定：
 *   - maxHistorySteps 不超过 maxSteps：历史里不可能有超过总步数的记录，多填无效
 *   - maxOutputTokens 全档 4096：单步只需产出一个结构化动作，深浅体现在步数而非单步长度
 *   - maxResultChars 仅作用于最近 3 步，第 4-10 步固定 2500、更早固定 1000（见 runtime.ts
 *     的 compressHistory），因此调高它的实际增益远小于字面倍数
 */
export const CONFIG_PROFILES: Record<Exclude<ConfigProfile, 'custom'>, Partial<RuntimeConfig>> = {
  // 快速：并发抢时间。所有模型同时启动，谁先出结果用谁，token 换延迟。
  fast: {
    maxSteps: 6,
    maxHistorySteps: 6,
    modelTimeoutSec: 60,
    maxOutputTokens: 4096,
    maxResultChars: 4096,
    batchSize: 2,
    staggerDelaySec: 0,
    autoModelRouting: false,
  },
  // 经济：单模型串行，能不并发就不并发。错峰拉到接近超时，让主模型有充分时间独占，
  // 只有它确实不行才叫下一个。模型顺序完全由用户选择决定，不做自动重排。
  economy: {
    maxSteps: 8,
    maxHistorySteps: 8,
    modelTimeoutSec: 90,
    maxOutputTokens: 4096,
    maxResultChars: 4096,
    batchSize: 1,
    staggerDelaySec: 60,
    autoModelRouting: false,
  },
  // 深入：步数与上下文都放宽。唯一 maxHistorySteps < maxSteps 的档位——32 步全保留
  // 收益有限（第 11 步之外每步只剩 1000 字符），压成摘要更划算。
  deep: {
    maxSteps: 32,
    maxHistorySteps: 16,
    modelTimeoutSec: 240,
    maxOutputTokens: 4096,
    maxResultChars: 8192,
    batchSize: 2,
    staggerDelaySec: 10,
    autoModelRouting: false,
  },
  // 尽力：以「跑成功」为目标。错峰留出补位窗口，主模型失败或迟迟不返回时备用模型顶上。
  besteffort: {
    maxSteps: 16,
    maxHistorySteps: 16,
    modelTimeoutSec: 120,
    maxOutputTokens: 4096,
    maxResultChars: 4096,
    batchSize: 2,
    staggerDelaySec: 10,
    autoModelRouting: false,
  },
};

/**
 * 取内置默认值全集（来源固定为 'default'）。
 * 用法：配置解析的最底层来源，供 config-store 与档位展开使用；
 * 当前使用：config-store.ts 的解析起始点、detectProfile 的对照基准。
 * Agent 运行时参数只从内置默认 + data/config.json 解析，不再读取环境变量。
 */
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

/** 展开 profile 为完整取值：未声明的字段继承 schema 内置默认。 */
export function resolveProfileValues(profile: Exclude<ConfigProfile, 'custom'>): RuntimeConfig {
  const values = {} as RuntimeConfig;
  for (const key of AGENT_CONFIG_KEYS) {
    (values as any)[key] = CONFIG_PROFILES[profile][key] ?? AGENT_CONFIG_SCHEMA[key].default;
  }
  return values;
}

export type ConfigWarning = { key: RuntimeConfigKey; code: string; params?: Record<string, unknown> };

/**
 * 检查取值搭配是否失效。与 validateConfig 的 errors 不同，这里只提示不拦截：
 * 值本身合法，只是组合起来达不到用户预期。
 *
 * 返回 i18n key 而非成文文案，由前端按当前语言渲染。
 */
export function collectConfigWarnings(values: RuntimeConfig): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  // 历史窗口大于总步数时，多出的额度永远填不满——历史里不可能有超过 maxSteps 条记录。
  if (values.maxHistorySteps > values.maxSteps) {
    warnings.push({
      key: 'maxHistorySteps',
      code: 'historyExceedsSteps',
      params: { maxSteps: values.maxSteps, maxHistorySteps: values.maxHistorySteps },
    });
  }

  return warnings;
}

/**
 * 由当前生效值反推所属档位，全部字段匹配才算命中，否则为 custom。
 *
 * 之所以不直接信任 config.json 里记录的 profile 标签：
 *   - 从未配置过时文件里没有该字段，但此时生效值就是内置默认（与 economy 一致），
 *     标签却会落到 custom，导致界面上没有任何档位被选中
 *   - 用户把参数改回某档位的原值后，标签仍停在 custom，与实际不符
 * 以实际值为准，两种情况都能自然消解。
 *
 * 多个档位取值相同时按 PROFILE_MATCH_ORDER 取第一个，保证结果稳定。
 */
export function detectProfile(values: RuntimeConfig): ConfigProfile {
  for (const profile of PROFILE_MATCH_ORDER) {
    const candidate = resolveProfileValues(profile);
    if (AGENT_CONFIG_KEYS.every(key => values[key] === candidate[key])) {
      return profile;
    }
  }
  return 'custom';
}
