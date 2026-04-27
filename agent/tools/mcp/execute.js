/**
 * MCP Client Tool — 调用外部 MCP 服务器的工具
 *
 * MCP (Model Context Protocol) 已达到 10,000+ 服务器、97M 月下载量。
 * 支持 sagent 调用 Big Model Radar 等 MCP 服务获取 AI 生态情报。
 *
 * 使用场景:
 * { tool: 'mcp', type: 'call_tool', server: 'big-model-radar', tool: 'get_latest', args: { type: 'ai-agents' } }
 */

const MCP_CLIENT_CONFIG = {
  'big-model-radar': {
    url: process.env.MCP_BIG_MODEL_RADAR_URL || 'https://big-model-radar-mcp.example.workers.dev',
    tools: ['list_reports', 'get_latest', 'get_report', 'search'],
  },
};

async function callMcpServer(serverName, toolName, args = {}) {
  const config = MCP_CLIENT_CONFIG[serverName];
  if (!config) {
    throw new Error(`未知的 MCP 服务器: ${serverName}，可用: ${Object.keys(MCP_CLIENT_CONFIG).join(', ')}`);
  }

  if (!config.tools.includes(toolName)) {
    throw new Error(`MCP 服务器 ${serverName} 不支持工具 ${toolName}，可用: ${config.tools.join(', ')}`);
  }

  const response = await fetch(`${config.url}/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(`MCP 调用失败: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

export async function executeMcpAction(action) {
  const { server, tool: toolName, args = {} } = action;

  if (!server) throw new Error('mcp 工具缺少 server');
  if (!toolName) throw new Error('mcp 工具缺少 tool');

  const result = await callMcpServer(server, toolName, args);
  return `MCP ${server}.${toolName} 结果:\n${String(result).slice(0, 8000)}`;
}