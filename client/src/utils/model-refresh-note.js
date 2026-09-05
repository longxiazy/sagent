// 把 POST /api/models/refresh 的结果翻成一句给人看的话。
// 关键是「无增减」也要有话说：拉取成功但列表没变时,界面若一声不吭,
// 用户分不清是供应商真没上新,还是按钮压根没生效。
export function modelRefreshNote(result, t) {
  const added = result?.added?.length || 0;
  const removed = result?.removed?.length || 0;
  const count = Number.isFinite(result?.count)
    ? result.count
    : (Array.isArray(result?.models) ? result.models.length : 0);
  return added || removed
    ? t('models.refreshChanged', { added, removed, count })
    : t('models.refreshUnchanged', { count });
}
