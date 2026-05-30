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
 *   - planner.js 的 createJsonPlanner() 作为 normalizeDecision 参数传入
 *   - agent/desktop/agent.js 的 toolUseToNormalizedDecision() 用于 Claude 模型
 */

import { cleanText } from './utils.ts';
import { inferTool } from './action-types.ts';

function normalizePath(value, fallback = '.') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sanitizeUrl(rawUrl) {
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

function normalizeBrowserAction(type, action) {
  if (type === 'open' || type === 'goto') {
    type = 'navigate';
  }

  if (type === 'get_page_content') {
    type = 'get_page_content';
    return { tool: 'browser', type };
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

  if (type === 'parallel_fetch') {
    const urls = Array.isArray(action.urls) ? action.urls.map(u => typeof u === 'string' ? u.trim() : '').filter(Boolean) : [];
    if (urls.length === 0) throw new Error('parallel_fetch 缺少 urls');
    return {
      tool: 'browser',
      type,
      urls: urls.map(u => /^https?:\/\//i.test(u) ? u : `https://${u}`),
      extractLinks: Boolean(action.extractLinks),
    };
  }

  throw new Error(`不支持的浏览器动作: ${type}`);
}

function normalizeSearchAction(type, action) {
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

function normalizeVisionAction(type, action) {
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

function normalizeFsAction(type, action) {
  if (type === 'list_dir') {
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

function normalizeTerminalAction(type, action) {
  if (type === 'run_safe' || type === 'run_confirmed' || type === 'run_review') {
    return {
      tool: 'terminal',
      type,
      command: typeof action.command === 'string' ? action.command.trim() : '',
      cwd: normalizePath(action.cwd, process.cwd()),
      timeoutMs: Number.isFinite(Number(action.timeoutMs))
        ? Math.min(Math.max(Number(action.timeoutMs), 1000), 20000)
        : 8000,
    };
  }

  throw new Error(`不支持的终端动作: ${type}`);
}

function normalizeMacOsAction(type, action) {
  if (type === 'open_app' || type === 'activate_app') {
    return {
      tool: 'macos',
      type,
      app: typeof action.app === 'string' ? action.app.trim() : '',
    };
  }

  if (type === 'list_windows' || type === 'capture_screen') {
    return {
      tool: 'macos',
      type,
    };
  }

  if (type === 'type_text') {
    return {
      tool: 'macos',
      type,
      text: typeof action.text === 'string' ? action.text : '',
    };
  }

  if (type === 'press_key') {
    const modifiers = Array.isArray(action.modifiers)
      ? action.modifiers
          .map(item => String(item || '').trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 4)
      : [];

    return {
      tool: 'macos',
      type,
      key: typeof action.key === 'string' ? action.key.trim().toLowerCase() : '',
      modifiers,
    };
  }

  if (type === 'click_at') {
    return {
      tool: 'macos',
      type,
      x: Number(action.x),
      y: Number(action.y),
    };
  }

  throw new Error(`不支持的 macOS 动作: ${type}`);
}

function normalizeIdeAction(type, action) {
  if (type === 'ide_list_tools' || type === 'list_tools') {
    return {
      tool: 'ide',
      type: 'ide_list_tools',
      refresh: Boolean(action.refresh),
    };
  }

  if (type === 'ide_call_tool' || type === 'call_tool') {
    const args = action.arguments && typeof action.arguments === 'object' && !Array.isArray(action.arguments)
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

function normalizeChromeAction(type, action) {
  if (type === 'chrome_list_tools' || type === 'chrome_list') {
    return {
      tool: 'chrome',
      type: 'chrome_list_tools',
      refresh: Boolean(action.refresh),
    };
  }

  if (type === 'chrome_call_tool' || type === 'chrome_call') {
    const args = action.arguments && typeof action.arguments === 'object' && !Array.isArray(action.arguments)
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

function normalizeSpawnAction(type, action) {
  if (type === 'spawn') {
    const tasks = Array.isArray(action.tasks)
      ? action.tasks
          .map(t => (typeof t === 'string' ? t.trim() : ''))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    if (tasks.length === 0) {
      throw new Error('spawn 缺少有效的 tasks 数组');
    }
    return {
      tool: 'spawn',
      type,
      tasks,
    };
  }
  throw new Error(`不支持的 spawn 动作: ${type}`);
}

function normalizeCoreAction(type, action) {
  if (type === 'finish') {
    return {
      tool: 'core',
      type,
      answer: typeof action.answer === 'string' ? action.answer.trim() : '',
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
    return {
      tool: 'core',
      type,
      message: typeof action.message === 'string' ? action.message.trim() : '',
      level: ['info', 'warning', 'discovery'].includes(action.level) ? action.level : 'info',
    };
  }
  throw new Error(`不支持的核心动作: ${type}`);
}

export function normalizeDesktopAgentDecision(payload) {
  const action = payload?.action;
  if (!action || typeof action !== 'object') {
    throw new Error('模型未返回 action');
  }

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

  let normalizedAction;
  if (tool === 'browser') {
    normalizedAction = normalizeBrowserAction(type, action);
  } else if (tool === 'fs') {
    normalizedAction = normalizeFsAction(type, action);
  } else if (tool === 'search') {
    normalizedAction = normalizeSearchAction(type, action);
  } else if (tool === 'vision') {
    normalizedAction = normalizeVisionAction(type, action);
  } else if (tool === 'terminal') {
    normalizedAction = normalizeTerminalAction(type, action);
  } else if (tool === 'macos') {
    normalizedAction = normalizeMacOsAction(type, action);
  } else if (tool === 'ide') {
    normalizedAction = normalizeIdeAction(type, action);
  } else if (tool === 'chrome') {
    normalizedAction = normalizeChromeAction(type, action);
  } else if (tool === 'spawn') {
    normalizedAction = normalizeSpawnAction(type, action);
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
