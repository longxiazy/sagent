/**
 * MCP Client Tool — 调用外部 MCP 服务器
 */
import { log } from '../../helpers/logger.js';

const MCP_CLIENT_CONFIG = {
  'big-model-radar': {
    url: process.env.MCP_BIG_MODEL_RADAR_URL || '',
    tools: ['list_reports', 'get_latest', 'get_report', 'search'],
  },
};

// Sanitize MCP tool names to prevent injection (NanoBot #3468)
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function validateName(name) {
  if (!name || !SAFE_NAME.test(name)) {
    throw new Error(`MCP 工具名称包含非法字符: ${name}`);
  }
}

export async function executeMcpAction(action) {
  const { server, tool: toolName, args = {} } = action;

  // Sanitize both server and tool name
  validateName(server);
  validateName(toolName);

  const config = MCP_CLIENT_CONFIG[server];
  if (!config) {
    throw new Error(`未知的 MCP 服务器: ${server}`);
  }
  if (!config.tools.includes(toolName)) {
    throw new Error(`MCP 服务器 ${server} 不支持工具 ${toolName}`);
  }
  if (!config.url) {
    throw new Error(`MCP 服务器 ${server} 未配置 URL`);
  }

  const response = await fetch(`${config.url}/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(`MCP 调用失败: ${response.status}`);
  }

  const result = await response.json();
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}