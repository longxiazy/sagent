export function getModelLabel(modelId, modelList) {
  const found = modelList.find(m => m.id === modelId);
  return found ? found.label : modelId.split('/').pop();
}

// 阶段 → i18n key（在组件里经 t() 取译文）。
export const PLAN_STAGE_LABELS = {
  pending: 'planStage.pending',
  thinking: 'planStage.thinking',
  success: 'planStage.success',
  winner: 'planStage.winner',
  failed: 'planStage.failed',
  discarded: 'planStage.discarded',
  abandoned: 'planStage.abandoned',
  cancelled: 'planStage.cancelled',
  consensus: 'planStage.consensus',
  rate_limited: 'planStage.rateLimited',
};

export const PLAN_STAGE_ICON = {
  pending: '·',
  thinking: '·',
  success: '✓',
  winner: '★',
  failed: '✗',
  discarded: '…',
  abandoned: '—',
  cancelled: '⊘',
  consensus: '★',
  rate_limited: '⏸',
};
