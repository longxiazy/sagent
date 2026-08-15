// Agent 参数与「实际选了几个模型」搭配失效时的提示。
// 取值本身都合法，只是在当前模型数下不参与执行，故只提示不阻断。

/**
 * 并发/错峰这两项只在多模型候选集上生效：
 * planner 发现只有一个模型时直接走单模型路径（agent/desktop/planner/index.ts），
 * batchSize / staggerDelaySec 完全不参与，模型一超时整个任务就失败，没有备胎顶上。
 * fast / deep / besteffort 三档的容错都建立在这个前提上，只选一个模型时它们
 * 只剩等待成本（更长的超时上限），拿不到补位收益。
 *
 * @param {{ modelCount?: number, batchSize?: unknown, staggerDelaySec?: unknown }} params
 * @returns {boolean} 需要提示"这些参数当前不生效"时为 true
 */
export function multiModelTuningIdle({ modelCount, batchSize, staggerDelaySec } = {}) {
  const count = Number(modelCount);
  // 一个模型都没选时用户还没做出选择，此时提示没有指向性，不打扰。
  if (!Number.isFinite(count) || count !== 1) return false;

  const batch = Number(batchSize);
  const stagger = Number(staggerDelaySec);
  return (Number.isFinite(batch) && batch > 1) || (Number.isFinite(stagger) && stagger > 0);
}
