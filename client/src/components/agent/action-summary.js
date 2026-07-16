// 把一个 action 浓缩成人类可读的一行意图。
// 供 StepCard 头部与 ModelPlanCard 折叠态复用，保证两处口径一致，
// 底层 tool.type 与完整参数只在执行详情中展示。

function fileName(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

// 返回 `tool.type`，tool 缺省视为 core。
export function actionTitle(action) {
  if (!action || typeof action !== 'object') return '';
  return `${action.tool || 'core'}.${action.type || '?'}`;
}

// 优先使用模型给出的任务意图；缺失时才根据动作生成自然语言兜底标题。
export function summarizeAction(action, rationale = '') {
  const intent = String(rationale || '').replace(/\s+/g, ' ').trim();
  if (intent) return intent;
  if (!action || typeof action !== 'object') return '';
  switch (action.type) {
    case 'read_file': return `读取 ${fileName(action.path) || '文件'}`;
    case 'write_file': return `更新 ${fileName(action.path) || '文件'}`;
    case 'list_dir': return action.path === '.' ? '查看项目文件' : `查看 ${fileName(action.path) || '目录'} 内容`;
    case 'search_files': return `查找 ${action.query || '相关文件'}`;
    case 'get_file_info': return `检查 ${fileName(action.path) || '文件'} 信息`;
    case 'web_search': return `搜索 ${action.query || '相关资料'}`;
    case 'http_fetch': return '读取网页正文';
    case 'navigate': return '打开目标网页';
    case 'get_page_content': return '读取当前页面内容';
    case 'click': return '操作页面元素';
    case 'type': return '填写页面内容';
    case 'scroll': return '继续查看页面内容';
    case 'wait': return '等待页面加载';
    case 'run_safe':
    case 'run_confirmed':
    case 'run_review': return '执行项目命令';
    case 'mcp_list_servers': return '检查可用服务';
    case 'mcp_list_tools': return '读取服务能力';
    case 'mcp_call_tool': return '调用外部能力';
    case 'ask_user': return action.question || '等待用户确认';
    case 'notify_user': return action.message || '通知用户';
    case 'finish': return '整理最终结果';
    default: return '执行下一步';
  }
}
