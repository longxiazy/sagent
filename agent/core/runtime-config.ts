/**
 * Runtime Config — 集中的运行时配置层（单一数据源 + 落盘）
 *
 * 把原先散落在 server.ts / runtime.ts / memory.ts 里、启动时从 process.env
 * 冻结的 Agent 行为参数收敛到这里。消费点改为每次读 get()，因此前台改完
 * 下次 agent 任务即自动生效，无需重启进程。
 *
 * 数据来源优先级：data/runtime-config.json（前台覆盖） > .env（默认值底）。
 *   - computeEnvDefaults() 从 process.env 算默认值（保留各处原有默认）
 *   - runtime-config.json 只存用户在前台改过的覆盖项
 *   - reset() 清空覆盖，回到 .env 默认
 *
 * get() 是同步的（compressHistory 等热路径是同步函数）；current 在模块加载时
 * 即初始化为 env 默认值，init() 再叠加 json，故任何时刻 get() 都安全。
 *
 * API Key 不在此管理（前台只读展示，仍在 .env 改）。
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../helpers/logger.ts';

export interface RuntimeConfig {
  maxSteps: number;
  modelTimeoutSec: number;
  staggerDelaySec: number;
  batchSize: number;
  observeDesktop: boolean;
  maxHistorySteps: number;
  maxResultChars: number;
  maxParallelResultChars: number;
  memoryMaxEntries: number;
  autoModelRouting: boolean;
}

type FieldSpec = { type: 'int' | 'bool'; min?: number; max?: number };

// 字段范围（防呆上下限）。staggerDelay 允许 0（无错峰）。
const FIELD_SPEC: Record<keyof RuntimeConfig, FieldSpec> = {
  maxSteps: { type: 'int', min: 1, max: 512 },
  modelTimeoutSec: { type: 'int', min: 1, max: 3600 },
  staggerDelaySec: { type: 'int', min: 0, max: 120 },
  batchSize: { type: 'int', min: 1, max: 32 },
  observeDesktop: { type: 'bool' },
  maxHistorySteps: { type: 'int', min: 1, max: 200 },
  maxResultChars: { type: 'int', min: 100, max: 200000 },
  maxParallelResultChars: { type: 'int', min: 100, max: 1000000 },
  memoryMaxEntries: { type: 'int', min: 1, max: 1000 },
  autoModelRouting: { type: 'bool' },
};

const FIELD_KEYS = Object.keys(FIELD_SPEC) as (keyof RuntimeConfig)[];

/** 纯函数：从 env 计算默认值（保留 server.ts / runtime.ts / memory.ts 原有默认）。 */
export function computeEnvDefaults(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  return {
    maxSteps: Number(env.AGENT_MAX_STEPS) || 8,
    modelTimeoutSec: Number(env.AGENT_MODEL_TIMEOUT) || 90,
    staggerDelaySec: Number(env.AGENT_STAGGER_DELAY) || 5,
    batchSize: Number(env.AGENT_BATCH_SIZE) || 1,
    observeDesktop: env.AGENT_OBSERVE_DESKTOP === 'true',
    maxHistorySteps: Number(env.AGENT_MAX_HISTORY_STEPS) || 20,
    maxResultChars: Number(env.AGENT_MAX_RESULT_CHARS) || 8000,
    maxParallelResultChars: Number(env.AGENT_MAX_PARALLEL_RESULT_CHARS) || 32000,
    memoryMaxEntries: Number(env.AGENT_MEMORY_MAX_ENTRIES) || 20,
    autoModelRouting: env.AGENT_AUTO_MODEL_ROUTING === 'true',
  };
}

/**
 * 纯函数：校验前台传来的 patch，返回 { clean, errors }。
 * - 只认识 FIELD_SPEC 里的键，未知键忽略
 * - int 字段必须是有限整数且在 [min,max]；bool 字段必须是布尔
 * - 任一字段非法记入 errors，且不进入 clean
 */
export function validateConfig(patch: any): { clean: Partial<RuntimeConfig>; errors: string[] } {
  const clean: Partial<RuntimeConfig> = {};
  const errors: string[] = [];
  if (!patch || typeof patch !== 'object') {
    return { clean, errors: ['配置必须是对象'] };
  }
  for (const key of FIELD_KEYS) {
    if (!(key in patch)) continue;
    const spec = FIELD_SPEC[key];
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

/** 纯函数：默认值 + 覆盖项合并（覆盖项只取已知且非空的键）。 */
export function mergeConfig(defaults: RuntimeConfig, overrides: Partial<RuntimeConfig> | null | undefined): RuntimeConfig {
  const merged = { ...defaults };
  if (overrides && typeof overrides === 'object') {
    for (const key of FIELD_KEYS) {
      if (key in overrides && (overrides as any)[key] != null) {
        (merged as any)[key] = (overrides as any)[key];
      }
    }
  }
  return merged;
}

// ── 单例 ──────────────────────────────────────────────
let envDefaults = computeEnvDefaults();
let overrides: Partial<RuntimeConfig> = {};
let current: RuntimeConfig = { ...envDefaults };
let filePath: string | null = null;
let saveChain: Promise<void> = Promise.resolve();

function recompute() {
  current = mergeConfig(envDefaults, overrides);
}

async function persist() {
  if (!filePath) return;
  const target = filePath;
  const tmp = target + '.tmp';
  await writeFile(tmp, JSON.stringify(overrides, null, 2));
  await rename(tmp, target);
}

export const runtimeConfig = {
  /** 启动时调用一次：设定落盘目录并加载 json 覆盖。 */
  async init(persistDir: string): Promise<RuntimeConfig> {
    envDefaults = computeEnvDefaults();
    filePath = path.join(persistDir, 'runtime-config.json');
    try {
      const raw = await readFile(filePath, 'utf-8');
      overrides = validateConfig(JSON.parse(raw)).clean;
    } catch {
      overrides = {};
    }
    recompute();
    return current;
  },

  /** 同步返回当前完整配置（热路径用）。 */
  get(): RuntimeConfig {
    return current;
  },

  /** env 默认值（前端展示「恢复默认」对照用）。 */
  defaults(): RuntimeConfig {
    return { ...envDefaults };
  },

  /** 校验并合并 patch，落盘后返回最新配置。校验失败抛错（含原因）。 */
  async update(patch: any): Promise<RuntimeConfig> {
    const { clean, errors } = validateConfig(patch);
    if (errors.length) {
      throw new Error(errors.join('；'));
    }
    overrides = { ...overrides, ...clean };
    recompute();
    saveChain = saveChain.then(persist).catch(err => log.error('[RuntimeConfig] 保存失败:', err?.message || err));
    await saveChain;
    return current;
  },

  /** 清空覆盖，回到 env 默认（删除覆盖文件）。 */
  async reset(): Promise<RuntimeConfig> {
    overrides = {};
    recompute();
    if (filePath) {
      const target = filePath;
      saveChain = saveChain.then(() => unlink(target)).catch(() => {});
      await saveChain;
    }
    return current;
  },
};

export type RuntimeConfigStore = typeof runtimeConfig;
