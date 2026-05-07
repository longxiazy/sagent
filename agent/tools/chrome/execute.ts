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
  const client = await getSharedChromeMcpClient(config);

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
    const result = await client.callTool(toolName, args);
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
