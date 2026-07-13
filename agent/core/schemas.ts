/**
 * Schemas — 动作标准化与校验层，将 LLM 输出的动作统一为安全的内部格式
 *
 * LLM 输出的动作格式不可控（可能缺字段、类型错误、URL 不合规等），
 * normalizeDesktopAgentDecision() 负责校验 + 清洗 + 设置合理默认值。
 *
 * 处理流程：
 *   1. 校验 action 和 action.type 必须存在
 *   2. 推断 tool（通过 action-types.js 的 inferTool）
 *   3. 根据 tool 路由到对应的 normalize 函数：
 *      - normalizeBrowserAction — 校验 URL、限制 wait 秒数等
 *      - normalizeFsAction      — 校验路径、限制读取字节数等
 *      - normalizeTerminalAction — 设置超时、白名单命令等
 *      - normalizeMacOsAction   — 校验坐标、按键名等
 *      - normalizeCoreAction    — finish/ask_user/notify_user
 *      - normalizeFetchAction   — 校验 URL、修复 extractLinks 参数错位等
 *
 * 调用场景：
 *   - planner/provider 的 agentPlan() 作为 normalizeDecision 使用
 */

import { cleanText } from './utils.ts';
import { inferTool } from './action-types.ts';
import type { AgentAction, AgentDecision, JsonObject } from './contracts.ts';

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(value: unknown, fallback = '.') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sanitizeUrl(rawUrl: unknown) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('navigate 缺少 url');
  }

  const value = rawUrl.trim();
  const nextValue = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(nextValue);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('仅支持 http/https 页面');
    }
    return url.toString();
  } catch {
    throw new Error(`无效的 URL: ${rawUrl}`);
  }
}

function normalizeBrowserAction(type: string, action: JsonObject): AgentAction {
  if (type === 'open' || type === 'goto') {
    type = 'navigate';
  }

  if (type === 'get_page_content') {
    return { tool: 'browser', type: 'get_page_content' };
  }

  if (type === 'navigate') {
    return {
      tool: 'browser',
      type,
      url: sanitizeUrl(action.url),
    };
  }

  if (type === 'click') {
    return {
      tool: 'browser',
      type,
      elementId: String(action.elementId || '').trim(),
    };
  }

  if (type === 'type') {
    return {
      tool: 'browser',
      type,
      elementId: String(action.elementId || '').trim(),
      text: typeof action.text === 'string' ? action.text : '',
      submit: Boolean(action.submit),
    };
  }

  if (type === 'wait') {
    const seconds = Number(action.seconds);
    return {
      tool: 'browser',
      type,
      seconds: Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 15) : 2,
    };
  }

  if (type === 'scroll') {
    const direction = action.direction === 'up' ? 'up' : 'down';
    const amount = Number.isFinite(Number(action.amount))
      ? Math.min(Math.max(Number(action.amount), 1), 10)
      : 3;
    return { tool: 'browser', type, direction, amount };
  }

  if (type === 'http_fetch') {
    const url = typeof action.url === 'string' ? action.url.trim() : '';
    if (!url) throw new Error('http_fetch 缺少 url');
    return {
      tool: 'browser',
      type,
      url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
      extractLinks: Boolean(action.extractLinks),
    };
  }

  throw new Error(`不支持的浏览器动作: ${type}`);
}

function normalizeSearchAction(type: string, action: JsonObject): AgentAction {
  if (type === 'web_search') {
    const query = typeof action.query === 'string' ? action.query.trim() : '';
    if (!query) throw new Error('web_search 缺少 query');
    return {
      tool: 'search',
      type,
      query,
      maxResults: Number.isFinite(Number(action.maxResults))
        ? Math.min(Math.max(Number(action.maxResults), 1), 10)
        : 5,
    };
  }
  throw new Error(`不支持的搜索动作: ${type}`);
}

function normalizeCodegraphAction(type: string, action: JsonObject): AgentAction {
  if (type === 'codegraph_query') {
    const query = typeof action.query === 'string' ? action.query.trim() : '';
    if (!query) throw new Error('codegraph_query 缺少 query');
    return { tool: 'codegraph', type, query };
  }
  throw new Error(`不支持的代码图谱动作: ${type}`);
}

function normalizeVisionAction(type: string, action: JsonObject): AgentAction {
  if (type === 'image_analyze') {
    const image = typeof action.image === 'string' ? action.image.trim() : '';
    const question = typeof action.question === 'string' ? action.question.trim() : '';
    if (!image) throw new Error('image_analyze 缺少 image');
    if (!question) throw new Error('image_analyze 缺少 question');
    return {
      tool: 'vision',
      type,
      image,
      question,
    };
  }
  throw new Error(`不支持的视觉动作: ${type}`);
}

function normalizeFsAction(type: string, action: JsonObject): AgentAction {
  if (type === 'list_dir') {
    return {
      tool: 'fs',
      type,
      path: normalizePath(action.path),
    };
  }

  if (type === 'get_file_info') {
    return {
      tool: 'fs',
      type,
      path: normalizePath(action.path),
    };
  }

  if (type === 'read_file') {
    return {
      tool: 'fs',
      type,
      path: normalizePath(action.path),
      maxBytes: Number.isFinite(Number(action.maxBytes)) ? Math.min(Math.max(Number(action.maxBytes), 256), 24000) : 12000,
    };
  }

  if (type === 'write_file') {
    return {
      tool: 'fs',
      type,
      path: normalizePath(action.path),
      content: typeof action.content === 'string' ? action.content : '',
      append: Boolean(action.append),
    };
  }

  if (type === 'search_files') {
    return {
      tool: 'fs',
      type,
      query: typeof action.query === 'string' ? action.query.trim() : '',
      path: normalizePath(action.path, '.'),
      include: typeof action.include === 'string' ? action.include.trim() : '*',
      maxResults: Number.isFinite(Number(action.maxResults)) ? Math.min(Math.max(Number(action.maxResults), 1), 50) : 20,
    };
  }

  throw new Error(`不支持的文件动作: ${type}`);
}

function normalizeTerminalAction(type: string, action: JsonObject): AgentAction {
  if (type === 'run_safe' || type === 'run_confirmed' || type === 'run_review') {
    return {
      tool: 'terminal',
      type,
      command: typeof action.command === 'string' ? action.command.trim() : '',
      // 不在此兜底成 process.cwd()：留空让执行层按当前项目根(或 process.cwd())解析，
      // 否则写死的绝对路径会盖掉项目根。模型可显式指定 cwd（绝对或相对项目根）。
      cwd: normalizePath(action.cwd, ''),
      timeoutMs: Number.isFinite(Number(action.timeoutMs))
        ? Math.min(Math.max(Number(action.timeoutMs), 1000), 20000)
        : 8000,
    };
  }

  throw new Error(`不支持的终端动作: ${type}`);
}

function normalizeIdeAction(type: string, action: JsonObject): AgentAction {
  if (type === 'ide_list_tools' || type === 'list_tools') {
    return {
      tool: 'ide',
      type: 'ide_list_tools',
      refresh: Boolean(action.refresh),
    };
  }

  if (type === 'ide_call_tool' || type === 'call_tool') {
    const args = isRecord(action.arguments)
      ? action.arguments
      : {};
    return {
      tool: 'ide',
      type: 'ide_call_tool',
      toolName: typeof action.toolName === 'string' ? action.toolName.trim() : '',
      arguments: args,
      refreshTools: Boolean(action.refreshTools),
    };
  }

  throw new Error(`不支持的 IDE 动作: ${type}`);
}

function normalizeChromeAction(type: string, action: JsonObject): AgentAction {
  if (type === 'chrome_list_tools' || type === 'chrome_list') {
    return {
      tool: 'chrome',
      type: 'chrome_list_tools',
      refresh: Boolean(action.refresh),
    };
  }

  if (type === 'chrome_call_tool' || type === 'chrome_call') {
    const args = isRecord(action.arguments)
      ? action.arguments
      : {};
    return {
      tool: 'chrome',
      type: 'chrome_call_tool',
      toolName: typeof action.toolName === 'string' ? action.toolName.trim() : '',
      arguments: args,
      refreshTools: Boolean(action.refreshTools),
    };
  }

  throw new Error(`不支持的 Chrome 动作: ${type}`);
}

function normalizeMcpAction(type: string, action: JsonObject): AgentAction {
  if (type === 'mcp_list_servers') return { tool: 'mcp', type };
  if (type === 'mcp_list_tools') {
    return {
      tool: 'mcp',
      type,
      serverName: typeof action.serverName === 'string' ? action.serverName.trim() : '',
      refresh: Boolean(action.refresh),
    };
  }
  if (type === 'mcp_call_tool') {
    return {
      tool: 'mcp',
      type,
      serverName: typeof action.serverName === 'string' ? action.serverName.trim() : '',
      toolName: typeof action.toolName === 'string' ? action.toolName.trim() : '',
      arguments: isRecord(action.arguments) ? action.arguments : {},
      refreshTools: Boolean(action.refreshTools),
    };
  }
  throw new Error(`不支持的通用 MCP 动作: ${type}`);
}

function normalizeCoreAction(type: string, action: JsonObject): AgentAction {
  if (type === 'finish' || type === 'answer' || type === 'final' || type === 'final_answer' || type === 'done') {
    const answer = typeof action.answer === 'string'
      ? action.answer.trim()
      : typeof action.content === 'string'
        ? action.content.trim()
        : typeof action.text === 'string'
          ? action.text.trim()
          : '';
    return {
      tool: 'core',
      type: 'finish',
      answer,
    };
  }
  if (type === 'ask_user') {
    return {
      tool: 'core',
      type,
      question: typeof action.question === 'string' ? action.question.trim() : '',
    };
  }
  if (type === 'notify_user') {
    const level = typeof action.level === 'string' && ['info', 'warning', 'discovery'].includes(action.level)
      ? action.level as 'info' | 'warning' | 'discovery'
      : 'info';
    return {
      tool: 'core',
      type,
      message: typeof action.message === 'string' ? action.message.trim() : '',
      level,
    };
  }
  throw new Error(`不支持的核心动作: ${type}`);
}

export function normalizeDesktopAgentDecision(payload: unknown): AgentDecision {
  if (!isRecord(payload) || !isRecord(payload.action)) {
    throw new Error('模型未返回 action');
  }
  const action = payload.action;

  const type = String(action.type || '').trim();
  if (!type) {
    throw new Error('action.type 不能为空');
  }

  const rawTool = String(action.tool || inferTool(type)).trim();
  if (!rawTool) {
    throw new Error(`无法根据动作类型推断 tool: ${type}`);
  }
  // fetch 已合并到 browser（统一走 WebView）
  const tool = rawTool === 'fetch' ? 'browser' : rawTool;

  let normalizedAction: AgentAction;
  if (tool === 'browser') {
    normalizedAction = normalizeBrowserAction(type, action);
  } else if (tool === 'fs') {
    normalizedAction = normalizeFsAction(type, action);
  } else if (tool === 'search') {
    normalizedAction = normalizeSearchAction(type, action);
  } else if (tool === 'codegraph') {
    normalizedAction = normalizeCodegraphAction(type, action);
  } else if (tool === 'vision') {
    normalizedAction = normalizeVisionAction(type, action);
  } else if (tool === 'terminal') {
    normalizedAction = normalizeTerminalAction(type, action);
  } else if (tool === 'ide') {
    normalizedAction = normalizeIdeAction(type, action);
  } else if (tool === 'chrome') {
    normalizedAction = normalizeChromeAction(type, action);
  } else if (tool === 'mcp') {
    normalizedAction = normalizeMcpAction(type, action);
  } else if (tool === 'core') {
    normalizedAction = normalizeCoreAction(type, action);
  } else {
    throw new Error(`不支持的工具: ${tool}`);
  }

  return {
    rationale: cleanText(payload?.rationale, 180),
    action: normalizedAction,
  };
}
