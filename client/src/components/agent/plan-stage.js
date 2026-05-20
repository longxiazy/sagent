export function getModelLabel(modelId, modelList) {
  const found = modelList.find(m => m.id === modelId);
  return found ? found.label : modelId.split('/').pop();
}

export const PLAN_STAGE_LABELS = {
  pending: '等待中…',
  thinking: '思考中…',
  success: '完成',
  winner: '采纳',
  failed: '失败',
  discarded: '已丢弃',
  abandoned: '放弃',
  cancelled: '已取消',
  consensus: '共识',
  rate_limited: '限流冷却',
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
