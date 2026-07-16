import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';
import { log } from '../../../helpers/logger.ts';
import { configStore } from '../../core/config-store.ts';
import type { McpServerConfig } from '../../core/config-schema.ts';

export const BUILTIN_MCP_SERVER_NAMES = new Set(['chrome']);

type GenericMcpEntry = { name: string; config: McpServerConfig };
type McpStatus = { phase: 'connecting' | 'connected' | 'discovering' | 'calling' | 'waiting' | 'progress' | 'completed' | 'error'; toolName?: string; message?: string; progress?: number; total?: number };
type McpStatusHandler = (status: McpStatus) => void;

const sharedClients = new Map<string, { key: string; client: GenericMcpClient }>();
const CONNECT_RETRY_DELAY_MS = 250;

function configKey(config: McpServerConfig) {
  return JSON.stringify(config);
}

export function listGenericMcpServers(): GenericMcpEntry[] {
  return Object.entries(configStore.mcpServers())
    .filter(([name, config]) => !BUILTIN_MCP_SERVER_NAMES.has(name) && config?.enabled)
    .map(([name, config]) => ({ name, config }));
}

export function isGenericMcpEnabled() {
  return listGenericMcpServers().length > 0;
}

export function getGenericMcpServer(name: string): McpServerConfig {
  const key = String(name || '').trim();
  if (!key) throw new Error('MCP server 名称不能为空');
  if (BUILTIN_MCP_SERVER_NAMES.has(key)) {
    throw new Error(`${key} 使用专用 MCP 适配器，请调用对应的 Chrome 工具`);
  }
  const config = configStore.mcpServers()[key];
  if (!config?.enabled) throw new Error(`MCP server ${key} 未配置或未启用`);
  return config;
}

export class GenericMcpClient {
  readonly name: string;
  readonly config: McpServerConfig;
  private client: Client | null = null;
  private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: any[] | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  private markDisconnected(client: Client, transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport) {
    if (this.client === client) this.client = null;
    if (this.transport === transport) this.transport = null;
    this.tools = null;
  }

  private async connectOnce(onStatus?: McpStatusHandler) {
    onStatus?.({ phase: 'connecting', message: `正在连接 ${this.name}` });
    const transportConfig = this.config.transport;
    const transport = transportConfig.type === 'stdio'
      ? new StdioClientTransport({
          command: transportConfig.command,
          args: transportConfig.args || [],
          cwd: transportConfig.cwd
            ? (path.isAbsolute(transportConfig.cwd) ? transportConfig.cwd : path.resolve(transportConfig.cwd))
            : process.cwd(),
          stderr: 'pipe',
        })
      : transportConfig.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(transportConfig.url))
        : new SSEClientTransport(new URL(transportConfig.url));
    const client = new Client({ name: 'sagent', version: '1.0.0' }, { capabilities: {} });
    this.transport = transport;
    client.onclose = () => {
      this.markDisconnected(client, transport);
      log.info(`[MCP:${this.name}] 连接已关闭，下次调用将自动重连`);
    };
    client.onerror = error => {
      log.warn(`[MCP:${this.name}] 连接异常: ${error.message}`);
    };
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', chunk => {
        const message = String(chunk || '').trim();
        if (message) log.debug(`[MCP:${this.name}][stderr] ${message.slice(0, 500)}`);
      });
    }
    try {
      await client.connect(transport, { timeout: this.config.toolTimeoutMs || 60_000 });
      this.client = client;
      onStatus?.({ phase: 'connected', message: `${this.name} 已连接` });
      return client;
    } catch (error) {
      this.markDisconnected(client, transport);
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private async connect(onStatus?: McpStatusHandler) {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        return await this.connectOnce(onStatus);
      } catch (firstError) {
        log.warn(`[MCP:${this.name}] 首次连接失败，准备重试: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
        await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
        return this.connectOnce(onStatus);
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async listTools({ refresh = false, signal, onStatus }: { refresh?: boolean; signal?: AbortSignal; onStatus?: McpStatusHandler } = {}) {
    if (!refresh && this.tools) return this.tools;
    const client = await this.connect(onStatus);
    onStatus?.({ phase: 'discovering', message: `正在读取 ${this.name} 的工具列表` });
    let result;
    try {
      result = await client.listTools({}, {
        signal,
        timeout: this.config.toolTimeoutMs || 60_000,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.close();
      const reconnected = await this.connect(onStatus);
      result = await reconnected.listTools({}, {
        signal,
        timeout: this.config.toolTimeoutMs || 60_000,
      });
    }
    this.tools = result.tools || [];
    onStatus?.({ phase: 'completed', message: `已发现 ${this.tools.length} 个工具` });
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>, { signal, onStatus }: { signal?: AbortSignal; onStatus?: McpStatusHandler } = {}) {
    const client = await this.connect(onStatus);
    onStatus?.({ phase: 'calling', toolName, message: `正在调用 ${this.name}/${toolName}` });
    onStatus?.({ phase: 'waiting', toolName, message: '工具处理中，等待返回结果' });
    try {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        signal,
        timeout: this.config.toolTimeoutMs || 60_000,
        resetTimeoutOnProgress: true,
        onprogress: progress => onStatus?.({
          phase: 'progress',
          toolName,
          message: progress.message || '工具正在处理',
          progress: progress.progress,
          total: progress.total,
        }),
      });
      onStatus?.({ phase: 'completed', toolName, message: `${this.name}/${toolName} 执行完成` });
      return result;
    } catch (error) {
      onStatus?.({ phase: 'error', toolName, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async close() {
    this.tools = null;
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) await client.close().catch(() => {});
    else if (transport) await transport.close().catch(() => {});
  }
}

export function createGenericMcpClient(name: string, config = getGenericMcpServer(name)) {
  return new GenericMcpClient(name, config);
}

export async function getSharedGenericMcpClient(name: string) {
  const config = getGenericMcpServer(name);
  const key = configKey(config);
  const existing = sharedClients.get(name);
  if (existing?.key === key) return existing.client;
  if (existing) await existing.client.close();
  const client = createGenericMcpClient(name, config);
  sharedClients.set(name, { key, client });
  return client;
}

export async function closeAllGenericMcpClients() {
  const clients = [...sharedClients.values()].map(entry => entry.client);
  sharedClients.clear();
  await Promise.all(clients.map(client => client.close()));
}
