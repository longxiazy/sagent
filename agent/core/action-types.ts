/**
 * Action Type → Tool 映射表
 *
 * 用途：当模型返回的 action 只有 type（如 "navigate"）但没有显式的 tool 字段时，
 * 通过 inferTool(type) 查表推断它属于哪个工具（browser / fs / terminal / macos / fetch / core）。
 *
 * 调用场景：
 *   - schemas.js 的 normalizeDesktopAgentDecision() 中：模型输出的 action 可能缺少 tool 字段，
 *     调用 inferTool(action.type) 补全，再根据 tool 路由到对应的 normalize 函数
 */

export const ACTION_TYPE_TO_TOOL = {
  // browser
  navigate: 'browser',
  google_search: 'browser',
  click: 'browser',
  type: 'browser',
  wait: 'browser',
  scroll: 'browser',
  get_page_content: 'browser',
  // fs
  list_dir: 'fs',
  read_file: 'fs',
  write_file: 'fs',
  search_files: 'fs',
  // terminal
  run_safe: 'terminal',
  run_confirmed: 'terminal',
  run_review: 'terminal',
  // macos
  open_app: 'macos',
  activate_app: 'macos',
  list_windows: 'macos',
  capture_screen: 'macos',
  type_text: 'macos',
  press_key: 'macos',
  click_at: 'macos',
  // fetch
  http_fetch: 'fetch',
  parallel_fetch: 'fetch',
  // core
  finish: 'core',
  ask_user: 'core',
  notify_user: 'core',
};

export function inferTool(type) {
  return ACTION_TYPE_TO_TOOL[type] ?? '';
}