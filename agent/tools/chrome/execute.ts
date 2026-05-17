import {
  formatChromeMcpError,
  getSharedChromeMcpClient,
  isChromeMcpEnabled,
  loadChromeMcpConfig,
  serializeChromePayload,
  summarizeChromeTool,
} from './mcp-client.ts';

const MAX_TEXT = 48000;

function truncate(text, max = MAX_TEXT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n...(内容已截断)` : value;
}

function formatToolList(tools, config) {
  // chrome_list_tools 面向模型展示工具摘要，只保留名称、参数字段和描述。
  const header = [
    `Chrome DevTools MCP 已连接 (${config.transport})`,
    `可用工具数: ${tools.length}`,
  ].join('\n');

  const lines = tools.map(tool => {
    const summary = summarizeChromeTool(tool);
    const args = summary.fields ? ` (${summary.fields})` : '';
    return `- ${summary.name}${args}${summary.description ? `: ${summary.description}` : ''}`;
  });

  return truncate(`${header}\n\n${lines.join('\n') || '当前未发现可用 Chrome 工具'}`);
}

function extractToolContent(result) {
  // MCP 工具结果可能同时包含 content 和 structuredContent，这里统一压成文本。
  const chunks = [];

  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && item.text) {
        chunks.push(item.text);
        continue;
      }
      chunks.push(serializeChromePayload(item));
    }
  }

  if (result?.structuredContent !== undefined) {
    chunks.push(serializeChromePayload(result.structuredContent));
  }

  if (chunks.length === 0) {
    chunks.push(serializeChromePayload(result));
  }

  return chunks.join('\n\n');
}

export async function executeChromeAction(action) {
  if (!isChromeMcpEnabled()) {
    throw new Error('Chrome MCP 未启用，请在 .env 中设置 CHROME_MCP_ENABLED=true 并配置连接参数');
  }

  const config = loadChromeMcpConfig();
  let client;
  try {
    // 复用共享 MCP client，避免每次 Chrome 动作都重新拉起 MCP 进程或 SSE 流。
    client = await getSharedChromeMcpClient(config);
  } catch (err: any) {
    if (err.message?.includes('error -54') || err.message?.includes('xattr')) {
      return [
        '⚠️ Chrome 浏览器因 macOS 权限问题无法启动（error -54）',
        '已自动回退到内置 HTTP 客户端，可继续使用 browser.http_fetch 等工具。',
        '如需修复 Chrome，请在终端执行:',
        '  xattr -cr /Applications/Google\\ Chrome.app',
      ].join('\n');
    }
    throw err;
  }

  if (action.type === 'chrome_list_tools') {
    const tools = await client.listTools({ refresh: Boolean(action.refresh) });
    return formatToolList(tools, config);
  }

  if (action.type === 'chrome_call_tool') {
    const toolName = String(action.toolName || '').trim();
    if (!toolName) {
      throw new Error('chrome_call_tool 缺少 toolName');
    }

    const tool = await client.getTool(toolName, { refresh: Boolean(action.refreshTools) });
    if (!tool) {
      throw new Error(`未找到 Chrome 工具 ${toolName}，请先调用 chrome_list_tools 确认可用工具名`);
    }

    const args = action.arguments && typeof action.arguments === 'object' && !Array.isArray(action.arguments)
      ? action.arguments : {};
    let result;
    try {
      // 这里保留原始 MCP tool 调用语义，错误恢复由 mcp-client.ts 统一处理。
      result = await client.callTool(toolName, args);
    } catch (err: any) {
      if (err.message?.includes('error -54') || err.message?.includes('xattr')) {
        return [
          '⚠️ Chrome 浏览器因 macOS 权限问题无法启动（error -54）',
          '已自动回退到内置 HTTP 客户端，可继续使用 browser.http_fetch 等工具。',
          '如需修复 Chrome，请在终端执行:',
          '  xattr -cr /Applications/Google\\ Chrome.app',
        ].join('\n');
      }
      throw err;
    }
    const content = extractToolContent(result);
    const status = result?.isError ? '失败' : '完成';

    const parts = [
      `Chrome 工具 ${toolName} 执行${status}`,
      `参数: ${serializeChromePayload(args)}`,
      `结果:\n${content}`,
    ];

    // navigate_page / new_page 成功后自动获取页面快照，让 LLM 立即看到页面内容
    const NAVIGATE_TOOLS = new Set(['navigate_page', 'new_page']);
    if (!result?.isError && NAVIGATE_TOOLS.has(toolName)) {
      try {
        const snapshotResult = await client.callTool('take_snapshot', {});
        const snapshotContent = extractToolContent(snapshotResult);
        parts.push(`\n[页面快照]\n${snapshotContent}`);
      } catch {
        parts.push('\n[页面快照获取失败，页面可能仍在加载]');
      }
    }

    return truncate(parts.join('\n\n'));
  }

  throw new Error(formatChromeMcpError(new Error(`不支持的 Chrome 动作类型: ${action.type}`), 'Chrome MCP'));
}
