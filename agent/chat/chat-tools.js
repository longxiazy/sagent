/**
 * Chat Tools — Chat 模式下暴露给 LLM 的工具定义
 *
 * 只包含安全的只读工具，从 createModelTools() 过滤得到。
 */

import { createModelTools } from '../core/tool-definitions.js';

const CHAT_TOOL_NAMES = new Set(['search_files', 'read_file', 'list_dir', 'http_fetch', 'run_safe']);

export function createChatTools() {
  return createModelTools().filter(t => CHAT_TOOL_NAMES.has(t.name));
}
