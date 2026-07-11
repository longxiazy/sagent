import { AGENT_CONFIG_KEYS, AGENT_CONFIG_SCHEMA } from '../agent/core/config-schema.ts';
import type { RuntimeConfigStore } from '../agent/core/runtime-config.ts';
import { log } from './logger.ts';

const REMOVED_VARIABLES = ['MODELS', 'AGENT_MULTI_MODELS', 'AGENT_HEADLESS'];
const LEGACY_CHROME_PREFIX = 'CHROME_MCP_';
const LEGACY_IDE_PREFIX = 'IDE_MCP_';

export function warnLegacyConfiguration(
  runtimeConfig: RuntimeConfigStore,
  env: Record<string, string | undefined> = process.env,
) {
  const removed = REMOVED_VARIABLES.filter(key => env[key] != null && String(env[key]).trim() !== '');
  if (removed.length > 0) {
    log.warn(`[Config] 已忽略废弃变量: ${removed.join(', ')}`);
  }

  const tuning = AGENT_CONFIG_KEYS
    .map(key => AGENT_CONFIG_SCHEMA[key].env)
    .filter(key => env[key] != null && String(env[key]).trim() !== '');
  if (tuning.length > 0) {
    log.warn(`[Config] Agent 调优环境变量仅作为兼容默认值，请迁移到 data/config.json 或设置页: ${tuning.join(', ')}`);
  }

  const stored = runtimeConfig.mcpServers();
  const chromeLegacy = Object.keys(env).filter(key => key.startsWith(LEGACY_CHROME_PREFIX) && env[key]);
  const ideLegacy = Object.keys(env).filter(key => key.startsWith(LEGACY_IDE_PREFIX) && env[key]);
  if (!stored.chrome && chromeLegacy.length > 0) {
    log.warn('[Config] CHROME_MCP_* 已进入兼容模式；在设置页保存 Chrome MCP 后将迁移到 mcpServers.chrome');
  }
  if (!stored.jetbrains && ideLegacy.length > 0) {
    log.warn('[Config] IDE_MCP_* 已进入兼容模式；在设置页保存 JetBrains MCP 后将迁移到 mcpServers.jetbrains');
  }
}
