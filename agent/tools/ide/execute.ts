import {
  applyIdeToolDefaults,
  formatIdeMcpError,
  getSharedIdeMcpClient,
  isIdeMcpEnabled,
  loadIdeMcpConfig,
  serializeIdePayload,
  summarizeIdeTool,
} from './mcp-client.ts';

const MAX_TEXT = 24000;

function truncate(text, max = MAX_TEXT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n...(内容已截断)` : value;
}

function formatToolList(tools, config) {
  const header = [
    `JetBrains IDE MCP 已连接 (${config.transport})`,
    `projectPath: ${config.projectPath}`,
    `可用工具数: ${tools.length}`,
  ].join('\n');

  const lines = tools.map(tool => {
    const summary = summarizeIdeTool(tool);
    const args = summary.fields ? ` (${summary.fields})` : '';
    return `- ${summary.name}${args}${summary.description ? `: ${summary.description}` : ''}`;
  });

  return truncate(`${header}\n\n${lines.join('\n') || '当前未发现可用 IDE 工具'}`);
}

function extractToolContent(result) {
  const chunks = [];

  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && item.text) {
        chunks.push(item.text);
        continue;
      }
      chunks.push(serializeIdePayload(item));
    }
  }

  if (result?.structuredContent !== undefined) {
    chunks.push(serializeIdePayload(result.structuredContent));
  }

  if (chunks.length === 0) {
    chunks.push(serializeIdePayload(result));
  }

  return chunks.join('\n\n');
}

export async function executeIdeAction(action, opts: { signal?: AbortSignal } = {}) {
  const signal = opts.signal;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Agent 已取消');
  if (!isIdeMcpEnabled()) {
    throw new Error('IDE MCP 未启用，请在 .env 中设置 IDE_MCP_ENABLED=true 并配置连接参数');
  }

  const config = loadIdeMcpConfig();
  const client = await getSharedIdeMcpClient(config);

  if (action.type === 'ide_list_tools') {
    const tools = await client.listTools({ refresh: Boolean(action.refresh), signal });
    return formatToolList(tools, config);
  }

  if (action.type === 'ide_call_tool') {
    const toolName = String(action.toolName || '').trim();
    if (!toolName) {
      throw new Error('ide_call_tool 缺少 toolName');
    }

    const tools = await client.listTools({ refresh: Boolean(action.refreshTools), signal });
    const tool = tools.find(item => item.name === toolName);
    if (!tool) {
      throw new Error(`未找到 IDE 工具 ${toolName}，请先调用 ide_list_tools 确认可用工具名`);
    }

    const args = applyIdeToolDefaults(action.arguments, tool, config);
    const result = await client.callTool(toolName, args, { signal });
    const content = extractToolContent(result);
    const status = result?.isError ? '失败' : '完成';

    return truncate([
      `IDE 工具 ${toolName} 执行${status}`,
      `参数: ${serializeIdePayload(args)}`,
      `结果:\n${content}`,
    ].join('\n\n'));
  }

  throw new Error(formatIdeMcpError(new Error(`不支持的 IDE 动作类型: ${action.type}`), 'IDE MCP'));
}
