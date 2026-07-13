import { configStore } from '../../core/config-store.ts';
import { getSharedGenericMcpClient, listGenericMcpServers } from './client.ts';

function truncate(value: string, max = configStore.get().maxResultChars) {
  return value.length <= max ? value : `${value.slice(0, max)}\n…（结果已截断）`;
}

function toolSummary(tool: any) {
  const schema = tool?.inputSchema || {};
  return {
    name: tool?.name || '',
    description: tool?.description || '',
    parameters: Object.keys(schema.properties || {}),
    required: Array.isArray(schema.required) ? schema.required : [],
    annotations: tool?.annotations || undefined,
  };
}

export function buildGenericMcpToolArguments(serverName: string, toolName: string, args: Record<string, unknown> = {}, cwd?: string | null) {
  if (serverName !== 'codex' || toolName !== 'codex') return args;
  return {
    ...args,
    cwd: cwd || process.cwd(),
    'approval-policy': 'never',
    sandbox: 'workspace-write',
  };
}

type McpOutput = { phase: 'connecting' | 'connected' | 'discovering' | 'calling' | 'waiting' | 'progress' | 'completed' | 'error'; toolName?: string; message?: string; progress?: number; total?: number };

export async function executeGenericMcpAction(action: any, opts: { signal?: AbortSignal; cwd?: string | null; onOutput?: (event: McpOutput) => void } = {}) {
  if (action.type === 'mcp_list_servers') {
    const servers = listGenericMcpServers().map(({ name, config }) => ({
      name,
      transport: config.transport.type,
      target: config.transport.type === 'stdio'
        ? `${config.transport.command} ${(config.transport.args || []).join(' ')}`.trim()
        : config.transport.url,
    }));
    return truncate(JSON.stringify({ servers }, null, 2));
  }

  const serverName = String(action.serverName || '').trim();
  const client = await getSharedGenericMcpClient(serverName);
  if (action.type === 'mcp_list_tools') {
    const tools = await client.listTools({ refresh: Boolean(action.refresh), signal: opts.signal, onStatus: opts.onOutput });
    return truncate(JSON.stringify({ serverName, tools: tools.map(toolSummary) }, null, 2));
  }

  if (action.type === 'mcp_call_tool') {
    const toolName = String(action.toolName || '').trim();
    if (!toolName) throw new Error('mcp_call_tool 缺少 toolName');
    const tools = await client.listTools({ refresh: Boolean(action.refreshTools), signal: opts.signal, onStatus: opts.onOutput });
    if (!tools.some(tool => tool.name === toolName)) {
      throw new Error(`MCP server ${serverName} 中未找到工具 ${toolName}，请先调用 mcp_list_tools`);
    }
    // Sagent 已在外层完成用户审批；Codex MCP 无法把二次审批交互传回当前 UI。
    // 同时保留 Codex workspace-write 与外层 Sagent sandbox 两层边界。
    const toolArguments = buildGenericMcpToolArguments(serverName, toolName, action.arguments || {}, opts.cwd);
    const result = await client.callTool(toolName, toolArguments, { signal: opts.signal, onStatus: opts.onOutput });
    return truncate(JSON.stringify({ serverName, toolName, result }, null, 2));
  }

  throw new Error(`不支持的通用 MCP 动作: ${action.type}`);
}
