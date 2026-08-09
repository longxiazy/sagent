/**
 * Action Type → Tool 映射表
 *
 * 用途：当模型返回的 action 只有 type（如 "navigate"）但没有显式的 tool 字段时，
 * 通过 inferTool(type) 查表推断它属于哪个工具
 * （browser / search / vision / fs / terminal / chrome / mcp / core）。
 *
 * 调用场景：
 *   - schemas.ts 的 normalizeDesktopAgentDecision()：行动补缺失的 tool 字段后路由到 normalize 函数
 *   - prompts.ts 的 actionExampleForTool()：按工具名反查归属，校验示例动作类型
 *   - helpers/agent-logging.ts：SSE 事件带上 tool 字段供前端展示
 */

import type { AgentTool } from './contracts.ts';

export const ACTION_TYPE_TO_TOOL = {
  // browser
  navigate: 'browser',
  click: 'browser',
  type: 'browser',
  wait: 'browser',
  scroll: 'browser',
  get_page_content: 'browser',
  http_fetch: 'browser',
  // search
  web_search: 'search',
  // vision
  image_analyze: 'vision',
  // fs
  list_dir: 'fs',
  get_file_info: 'fs',
  read_file: 'fs',
  write_file: 'fs',
  search_files: 'fs',
  // terminal
  run_safe: 'terminal',
  run_confirmed: 'terminal',
  run_review: 'terminal',
  // chrome
  chrome_list_tools: 'chrome',
  chrome_call_tool: 'chrome',
  chrome_list: 'chrome',
  chrome_call: 'chrome',
  // generic MCP
  mcp_list_servers: 'mcp',
  mcp_list_tools: 'mcp',
  mcp_call_tool: 'mcp',
  // core
  finish: 'core',
  answer: 'core',
  final: 'core',
  final_answer: 'core',
  done: 'core',
  ask_user: 'core',
  notify_user: 'core',
} as const satisfies Record<string, AgentTool>;

/** 全部已知 action type 的联合类型 */
export type KnownActionType = keyof typeof ACTION_TYPE_TO_TOOL;

/**
 * 由 action type 反查归属工具；映射表外返回 ''。
 * 用法：传给模型输出的 action，在表内返回 'browser'/'fs' 等工具名，未知类型返回空串。
 * 当前使用：schemas.ts 的 normalizeDesktopAgentDecision()、prompts.ts 的工具示例构建、
 * helpers/agent-logging.ts 的 SSE 事件补全 tool 字段。
 */
export function inferTool(type: string): AgentTool | '' {
  return ACTION_TYPE_TO_TOOL[type] ?? '';
}
