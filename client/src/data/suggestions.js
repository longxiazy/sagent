// "试试这些任务/问题"建议数据已迁到后端,前端通过 GET /api/suggestions 拉取。
// 首屏拉取前用这个空对象占位,避免 undefined。
export const EMPTY_SUGGESTIONS = { agent: [] };
