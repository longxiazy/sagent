/**
 * 多模型结果聚合 —— 按 action 键(tool.type)分组取多数派,产出共识字段。
 * 用法：vote 策略收齐所有模型决策后调用；空列表返回 null，单模型直接带 unanimous 共识返回。
 * 当前使用：desktop/planner/strategies/vote.ts。
 */
export function aggregateModelResults(modelResults: any[]) {
  if (modelResults.length === 0) return null;

  if (modelResults.length === 1) {
    const result = modelResults[0];
    const key = `${result.action?.tool || 'core'}.${result.action?.type || 'unknown'}`;
    return {
      ...result,
      consensus: {
        agreed: 1,
        total: 1,
        unanimous: true,
        actionKey: key,
        allResults: modelResults.map(item => ({
          model: item.model,
          rationale: item.rationale,
          actionKey: `${item.action?.tool || 'core'}.${item.action?.type || 'unknown'}`,
          action: item.action,
          usage: item.usage,
        })),
      },
    };
  }

  const groups: Record<string, any[]> = {};
  for (const result of modelResults) {
    const key = `${result.action?.tool || 'core'}.${result.action?.type || 'unknown'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(result);
  }

  let bestKey = null;
  let bestCount = 0;
  for (const [key, items] of Object.entries(groups)) {
    if (items.length > bestCount) {
      bestCount = items.length;
      bestKey = key;
    }
  }

  const consensus = groups[bestKey];
  const isUnanimous = consensus.length === modelResults.length;
  const winner = consensus[0];

  return {
    ...winner,
    consensus: {
      agreed: bestCount,
      total: modelResults.length,
      unanimous: isUnanimous,
      actionKey: bestKey,
      allResults: modelResults.map(result => ({
        model: result.model,
        rationale: result.rationale,
        actionKey: `${result.action?.tool || 'core'}.${result.action?.type || 'unknown'}`,
        action: result.action,
        usage: result.usage,
      })),
    },
  };
}
