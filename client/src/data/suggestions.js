// 默认模型占位:首屏渲染时先用,后端返回模型列表后会替换。
export const DEFAULT_MODELS = [
  { id: 'deepseek-ai/deepseek-v4-flash', label: 'deepseek-v4-pro' },
];

// "试试这些任务/问题"建议数据已迁到后端,前端通过 GET /api/suggestions 拉取。
// 首屏拉取前用这个空对象占位,避免 undefined。
export const EMPTY_SUGGESTIONS = { agent: [] };
