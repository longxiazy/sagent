import type { ConfigStore } from '../agent/core/config-store.ts';
import { log } from './logger.ts';

const REMOVED_VARIABLES = ['MODELS', 'AGENT_MULTI_MODELS', 'AGENT_HEADLESS'];
// Agent 调优参数曾支持的环境变量，现已不再读取（仅用于提示用户迁移）。
const LEGACY_TUNING_VARIABLES = [
  'AGENT_MAX_STEPS',
  'AGENT_MODEL_TIMEOUT',
  'AGENT_MAX_OUTPUT_TOKENS',
  'AGENT_STAGGER_DELAY',
  'AGENT_BATCH_SIZE',
  'AGENT_OBSERVE_DESKTOP',
  'AGENT_MAX_HISTORY_STEPS',
  'AGENT_MAX_RESULT_CHARS',
  'AGENT_AUTO_MODEL_ROUTING',
];
const LEGACY_CHROME_PREFIX = 'CHROME_MCP_';

export function warnLegacyConfiguration(
  configStore: ConfigStore,
  env: Record<string, string | undefined> = process.env,
) {
  const removed = REMOVED_VARIABLES.filter(key => env[key] != null && String(env[key]).trim() !== '');
  if (removed.length > 0) {
    log.warn(`[Config] 已忽略废弃变量: ${removed.join(', ')}`);
  }

  const tuning = LEGACY_TUNING_VARIABLES
    .filter(key => env[key] != null && String(env[key]).trim() !== '');
  if (tuning.length > 0) {
    log.warn(`[Config] Agent 调优环境变量已不再生效，请改在 data/config.json 或设置页配置: ${tuning.join(', ')}`);
  }

  const stored = configStore.mcpServers();
  const chromeLegacy = Object.keys(env).filter(key => key.startsWith(LEGACY_CHROME_PREFIX) && env[key]);
  if (!stored.chrome && chromeLegacy.length > 0) {
    log.warn('[Config] CHROME_MCP_* 已进入兼容模式；在设置页保存 Chrome MCP 后将迁移到 mcpServers.chrome');
  }
}
