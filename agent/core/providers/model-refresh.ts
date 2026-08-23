/**
 * ModelRefresher — 运行期手动全量重拉供应商模型列表
 *
 * 启动时 registry.loadModelConfig() 得到的 modelConfig 被路由、agent runner、
 * worker 启动参数等多处按引用持有，此前只有重启后端才能看到供应商上新/下线的模型。
 * 这里提供手动刷新：重新问一遍所有供应商，成功后 splice 就地替换同一个数组，
 * 所有持有者立刻看到新表（与 model-policy.ts 就地重算标记是同一个理由）。
 *
 * 全有或全无：只要有任一供应商失败就整体放弃并抛错，现有列表一个字节都不动。
 * 否则一次网络抖动就会让那家的模型凭空消失，而用户无从分辨「是下线了还是没拉到」。
 * 启动时的取舍相反（有一家能用就先跑起来），所以两条路径不共用判定。
 */

import { log } from '../../../helpers/logger.ts';
import type { ModelFetchResult, ProviderRegistry } from './registry.ts';
import type { ModelInfo } from './types.ts';

export interface ModelRefreshStatus {
  /** 本份列表的拉取时刻（ISO）。构造时即启动拉取时刻。 */
  refreshedAt: string;
  count: number;
}

export interface ModelRefreshResult extends ModelRefreshStatus {
  /** 相对刷新前的差异。两个都为空 = 拉到了，但供应商侧没有任何增减。 */
  added: string[];
  removed: string[];
}

export interface ModelRefresher {
  status(): ModelRefreshStatus;
  /** 成功返回新状态与增删差异；任一供应商失败则抛错，且 modelConfig 保持原样。 */
  refresh(): Promise<ModelRefreshResult>;
}

// 日志里逐个列出改动的模型 id：手动刷新是低频动作，"变了什么" 比 "变了几个" 有用得多。
// 只在异常多的时候截断，避免一次刷新刷屏。
function formatIds(ids: string[], limit = 20) {
  if (ids.length <= limit) return ids.join(', ');
  return `${ids.slice(0, limit).join(', ')} …等 ${ids.length} 个`;
}

export function createModelRefresher({
  registry,
  modelConfig,
  refreshedAt = new Date().toISOString(),
  now = () => new Date().toISOString(),
}: {
  registry: Pick<ProviderRegistry, 'fetchModels'>;
  modelConfig: ModelInfo[];
  refreshedAt?: string;
  now?: () => string;
}): ModelRefresher {
  let lastRefreshedAt = refreshedAt;
  let inFlight: Promise<ModelRefreshResult> | null = null;

  function status(): ModelRefreshStatus {
    return { refreshedAt: lastRefreshedAt, count: modelConfig.length };
  }

  async function runRefresh(): Promise<ModelRefreshResult> {
    let fetched: ModelFetchResult;
    try {
      fetched = await registry.fetchModels();
    } catch (err: any) {
      // fetchModels 内部已用 allSettled 收敛单家失败，走到这里说明是它自己崩了。
      // 兜住并记一笔，保证「刷新失败」在日志里永远有迹可循。
      log.warn(`[Models] 手动刷新失败: ${err?.message || err}`);
      throw err;
    }
    const { models, failures } = fetched;
    if (failures.length > 0) {
      const reason = `模型列表未更新，仍保留原有 ${modelConfig.length} 个模型。失败原因:\n  - ${failures.join('\n  - ')}`;
      // 日志与抛给前端的原因写在同一处，免得两边说法对不上。
      log.warn(`[Models] 手动刷新失败，${reason}`);
      throw new Error(reason);
    }

    const before = new Set(modelConfig.map(m => m.id));
    const after = new Set(models.map(m => m.id));
    const added = models.map(m => m.id).filter(id => !before.has(id));
    const removed = [...before].filter(id => !after.has(id));

    // 单次 splice 完成全量替换：过程中没有「列表只剩一半」的中间态，
    // 正在跑的 run 逐步查 modelConfig 时不会读到残缺表。
    modelConfig.splice(0, modelConfig.length, ...models);
    lastRefreshedAt = now();

    // 「没拉到新东西」也要留痕：否则用户点了没反应时，日志里查不到到底刷没刷过。
    if (added.length === 0 && removed.length === 0) {
      log.info(`[Models] 手动刷新完成，共 ${models.length} 个模型，无增减`);
    } else {
      log.info(
        `[Models] 手动刷新完成，共 ${models.length} 个模型`
        + (added.length ? `；新增 ${added.length}: ${formatIds(added)}` : '')
        + (removed.length ? `；移除 ${removed.length}: ${formatIds(removed)}` : ''),
      );
    }

    return { ...status(), added, removed };
  }

  function refresh(): Promise<ModelRefreshResult> {
    // 连点两下或多个页面同时点，只打一次供应商接口；失败后 inFlight 归位，不影响重试。
    if (!inFlight) {
      inFlight = runRefresh().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return { status, refresh };
}
