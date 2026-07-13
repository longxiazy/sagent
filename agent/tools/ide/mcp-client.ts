import path from 'node:path';
import { configStore } from '../../core/config-store.ts';
import { createGenericMcpClient, type GenericMcpClient } from '../mcp/client.ts';
import type { McpServerConfig } from '../../core/config-schema.ts';

const DEFAULT_SSE_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 6365;
const DEFAULT_SSE_PATH = '/sse';
const DEFAULT_STDIO_COMMAND = 'npx';
const DEFAULT_STDIO_ARGS = ['-y', '@jetbrains/mcp-proxy'];

let sharedClient: GenericMcpClient | null = null;
let sharedClientKey = '';

function envFlag(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function toAbsolutePath(rawPath: unknown, fallback = process.cwd()) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return fallback;
  return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(fallback, rawPath);
}

function parseArgs(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [...DEFAULT_STDIO_ARGS];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return value.trim().split(/\s+/).filter(Boolean);
}

function extractSchema(tool: any) {
  return tool?.inputSchema || tool?.input_schema || {};
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function isIdeMcpEnabled(env = process.env) {
  const configured = configStore.mcpServers().jetbrains;
  if (configured) return configured.enabled;
  return envFlag(env.IDE_MCP_ENABLED) || Boolean(
    env.IDE_MCP_TRANSPORT || env.IDE_MCP_URL || env.IDE_MCP_SSE_URL
    || env.IDE_MCP_COMMAND || env.IDE_MCP_HOST || env.IDE_MCP_PORT
  );
}

export function buildIdePromptLines(env = process.env) {
  if (!isIdeMcpEnabled(env)) return [];
  return [
    '当 IDE MCP 已启用时，可先使用 ide_list_tools 查看 JetBrains IDE 暴露的 MCP 工具，再用 ide_call_tool 调用具体工具。',
    'ide_call_tool 的 toolName 必须来自 ide_list_tools 返回结果，arguments 传对应参数对象。',
    '如果目标工具支持 projectPath 且未显式传入，系统会自动补上 IDE_PROJECT_PATH 或当前工作目录。',
  ];
}

export function loadIdeMcpConfig(env = process.env) {
  const configured = configStore.mcpServers().jetbrains;
  if (configured) {
    const transport = configured.transport;
    const projectPath = toAbsolutePath(configured.projectPath || '.', process.cwd());
    return {
      enabled: configured.enabled,
      transport: transport.type,
      host: DEFAULT_SSE_HOST,
      port: DEFAULT_SSE_PORT,
      ssePath: DEFAULT_SSE_PATH,
      url: transport.type !== 'stdio' ? transport.url : null,
      messagesUrl: transport.type === 'sse' ? transport.messagesUrl || null : null,
      command: transport.type === 'stdio' ? transport.command : DEFAULT_STDIO_COMMAND,
      args: transport.type === 'stdio' ? transport.args || [] : DEFAULT_STDIO_ARGS,
      cwd: toAbsolutePath(transport.type === 'stdio' ? transport.cwd || projectPath : projectPath, process.cwd()),
      projectPath,
      toolTimeoutMs: configured.toolTimeoutMs || 60_000,
      source: 'config',
    };
  }
  const transport = String(env.IDE_MCP_TRANSPORT || '').trim().toLowerCase() === 'stdio' ? 'stdio' : 'sse';
  const host = String(env.IDE_MCP_HOST || DEFAULT_SSE_HOST).trim() || DEFAULT_SSE_HOST;
  const port = Number(env.IDE_MCP_PORT || DEFAULT_SSE_PORT) || DEFAULT_SSE_PORT;
  const ssePath = String(env.IDE_MCP_SSE_PATH || DEFAULT_SSE_PATH).trim() || DEFAULT_SSE_PATH;
  const projectPath = toAbsolutePath(env.IDE_PROJECT_PATH || env.IDE_MCP_PROJECT_PATH, process.cwd());
  return {
    enabled: isIdeMcpEnabled(env),
    transport,
    host,
    port,
    ssePath,
    url: String(env.IDE_MCP_URL || env.IDE_MCP_SSE_URL || '').trim() || null,
    messagesUrl: String(env.IDE_MCP_MESSAGES_URL || '').trim() || null,
    command: String(env.IDE_MCP_COMMAND || DEFAULT_STDIO_COMMAND).trim() || DEFAULT_STDIO_COMMAND,
    args: parseArgs(env.IDE_MCP_ARGS),
    cwd: toAbsolutePath(env.IDE_MCP_CWD || projectPath, process.cwd()),
    projectPath,
    toolTimeoutMs: Number(env.IDE_MCP_TOOL_TIMEOUT_MS) || 60_000,
    source: 'env',
  };
}

function toSdkConfig(config = loadIdeMcpConfig()): McpServerConfig {
  const transport = config.transport === 'stdio'
    ? { type: 'stdio' as const, command: config.command, args: config.args, cwd: config.cwd }
    : config.transport === 'http'
      ? { type: 'http' as const, url: config.url! }
      : { type: 'sse' as const, url: config.url || `http://${config.host}:${config.port}${config.ssePath}`, ...(config.messagesUrl ? { messagesUrl: config.messagesUrl } : {}) };
  return { enabled: config.enabled, transport, projectPath: config.projectPath, toolTimeoutMs: config.toolTimeoutMs };
}

export function createIdeMcpClient(config = loadIdeMcpConfig()) {
  return createGenericMcpClient('jetbrains', toSdkConfig(config));
}

export async function getSharedIdeMcpClient(config = loadIdeMcpConfig()) {
  const key = JSON.stringify(toSdkConfig(config));
  if (sharedClient && sharedClientKey === key) return sharedClient;
  if (sharedClient) await sharedClient.close();
  sharedClient = createIdeMcpClient(config);
  sharedClientKey = key;
  return sharedClient;
}

export async function resetIdeMcpClientForTests() {
  const client = sharedClient;
  sharedClient = null;
  sharedClientKey = '';
  if (client) await client.close();
}

export function applyIdeToolDefaults(args: any, tool: any, config = loadIdeMcpConfig()) {
  const normalized = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const properties = extractSchema(tool)?.properties || {};
  if (config.projectPath && Object.prototype.hasOwnProperty.call(properties, 'projectPath') && !normalized.projectPath) {
    normalized.projectPath = config.projectPath;
  }
  return normalized;
}

export function formatIdeMcpError(error: any, context = '') {
  return `${context ? `${context}: ` : ''}${error?.message || safeJson(error)}`;
}

export function summarizeIdeTool(tool: any) {
  const schema = extractSchema(tool);
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return {
    name: tool?.name || '',
    description: tool?.description || '',
    fields: Object.keys(schema?.properties || {}).map(name => `${name}${required.has(name) ? '*' : ''}`).join(', '),
  };
}

export function serializeIdePayload(value: unknown) {
  return safeJson(value);
}
