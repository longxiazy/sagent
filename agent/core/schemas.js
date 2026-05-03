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

import { cleanText } from './utils.js';
import { inferTool } from './action-types.js';

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

  if (type === 'google_search') {
    return {
      tool: 'browser',
      type,
      query: typeof action.query === 'string' ? action.query.trim() : '',
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

  throw new Error(`不支持的浏览器动作: ${type}`);
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

function normalizeFetchAction(type, action) {
  // Fix models that put extractLinks into the URL: "url":"...&extractLinks":true}
  if (typeof action.url === 'string' && /[&?]extractLinks[=:]/i.test(action.url)) {
    action.url = action.url.replace(/[&?]extractLinks[=:]["']?true["']?/gi, '');
    if (action.extractLinks === undefined) {
      action.extractLinks = true;
    }
  }

  if (type === 'parallel_fetch') {
    const urls = Array.isArray(action.urls) ? action.urls : [];
    if (urls.length === 0) {
      throw new Error('parallel_fetch 缺少 urls');
    }
    return {
      tool: 'fetch',
      type,
      urls: urls.map(u => {
        const url = typeof u === 'string' ? u.trim() : '';
        if (!url) return null;
        return /^https?:\/\//i.test(url) ? url : `https://${url}`;
      }).filter(Boolean),
      extractLinks: Boolean(action.extractLinks),
    };
  }

  if (type !== 'http_fetch') {
    throw new Error(`不支持的抓取动作: ${type}`);
  }

  const url = typeof action.url === 'string' ? action.url.trim() : '';
  if (!url) {
    throw new Error('http_fetch 缺少 url');
  }

  return {
    tool: 'fetch',
    type,
    url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
    extractLinks: Boolean(action.extractLinks),
    timeoutMs: Number.isFinite(Number(action.timeoutMs))
      ? Math.min(Math.max(Number(action.timeoutMs), 3000), 20000)
      : 10000,
  };
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

  const tool = String(action.tool || inferTool(type)).trim();
  if (!tool) {
    throw new Error(`无法根据动作类型推断 tool: ${type}`);
  }

  let normalizedAction;
  if (tool === 'browser') {
    normalizedAction = normalizeBrowserAction(type, action);
  } else if (tool === 'fs') {
    normalizedAction = normalizeFsAction(type, action);
  } else if (tool === 'terminal') {
    normalizedAction = normalizeTerminalAction(type, action);
  } else if (tool === 'macos') {
    normalizedAction = normalizeMacOsAction(type, action);
  } else if (tool === 'core') {
    normalizedAction = normalizeCoreAction(type, action);
  } else if (tool === 'fetch') {
    normalizedAction = normalizeFetchAction(type, action);
  } else {
 } else if (tool === 'git') {
 return { tool: 'git', type: action.type || 'status', path: action.path || '.', extra: action.extra || '' };
    throw new Error(`不支持的工具: ${tool}`);
  }

  return {
    rationale: cleanText(payload?.rationale, 180),
    action: normalizedAction,
  };
}
