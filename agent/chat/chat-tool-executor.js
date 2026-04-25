/**
 * Chat Tool Executor — Chat 模式下的工具执行器（只读子集）
 *
 * Chat 模式支持有限的工具调用（search_files, read_file, list_dir, http_fetch, run_safe），
 * 这些都是只读/安全的操作，不需要用户审批，结果截断到 12KB 防止上下文爆炸。
 *
 * 与 Agent 模式的区别：
 *   - Agent 模式有完整的 observe → decide → authorize → execute 循环
 *   - Chat 模式是简单的 LLM → tool_call → 执行 → 返回结果，无审批、无浏览器
 *
 * 调用场景：
 *   - routes/chat.js 的聊天流中，检测到 LLM 返回 tool_calls 时调用
 */

import { executeFsAction } from '../tools/fs/execute.js';
import { executeFetchAction } from '../tools/fetch/execute.js';
import { executeTerminalAction } from '../tools/terminal/run.js';

export async function executeChatTool(name, input) {
  const MAX_RESULT = 12000;

  if (name === 'search_files') {
    return truncate(await executeFsAction({ tool: 'fs', type: 'search_files', ...input }), MAX_RESULT);
  }
  if (name === 'read_file') {
    return truncate(await executeFsAction({ tool: 'fs', type: 'read_file', ...input }), MAX_RESULT);
  }
  if (name === 'list_dir') {
    return truncate(await executeFsAction({ tool: 'fs', type: 'list_dir', ...input }), MAX_RESULT);
  }
  if (name === 'http_fetch') {
    return truncate(await executeFetchAction({ tool: 'fetch', type: 'http_fetch', ...input }), MAX_RESULT);
  }
  if (name === 'run_safe') {
    return truncate(await executeTerminalAction({ tool: 'terminal', type: 'run_safe', ...input }), MAX_RESULT);
  }
  throw new Error(`Chat 模式不支持工具: ${name}`);
}

function truncate(text, max) {
  const str = String(text || '');
  return str.length > max ? str.slice(0, max) + '\n...(已截断)' : str;
}
