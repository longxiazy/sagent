/**
 * Action Type → Tool 映射表
 *
 * 用途：当模型返回的 action 只有 type（如 "navigate"）但没有显式的 tool 字段时，
 * 通过 inferTool(type) 查表推断它属于哪个工具（browser / fs / terminal / fetch / core）。
 *
 * 调用场景：
 *   - schemas.js 的 normalizeDesktopAgentDecision() 中：模型输出的 action 可能缺少 tool 字段，
 *     调用 inferTool(action.type) 补全，再根据 tool 路由到对应的 normalize 函数
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
  // codegraph
  codegraph_query: 'codegraph',
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

export type KnownActionType = keyof typeof ACTION_TYPE_TO_TOOL;

export function inferTool(type: string): AgentTool | '' {
  return ACTION_TYPE_TO_TOOL[type] ?? '';
}
