/**
 * Action Router — 根据动作的 tool 字段路由到对应的处理函数
 *
 * Agent runtime 的 execute 阶段使用：runtime 拿到 normalize 后的 action（如 {tool:'browser', type:'navigate'}），
 * router 根据 tool 名分发到对应 handler（如 browser handler 调用 Playwright）。
 *
 * 调用场景：
 *   - agent/desktop/agent.js 中 createActionRouter({ core, browser, fs, fetch, terminal, macos })
 *   - runtime.js 的 execute 步骤调用 routeAction(state, action, context)
 *
 * handlers 结构示例：
 *   { browser: async (state, action) => ..., fs: async (state, action) => ..., ... }
 */

export function createActionRouter(handlers, { defaultTool } = {}) {
  return async (state, action, context) => {
    const toolName =
      typeof action?.tool === 'string' && action.tool.trim()
        ? action.tool.trim()
        : defaultTool;

    if (!toolName) {
      throw new Error('动作缺少 tool');
    }

    const handler = handlers?.[toolName];
    if (typeof handler !== 'function') {
      throw new Error(`未找到工具处理器: ${toolName}`);
    }

    return handler(state, action, context);
  };
}
