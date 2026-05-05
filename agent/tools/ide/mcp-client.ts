import { spawn } from 'node:child_process';
import path from 'node:path';
import { log } from '../../../helpers/logger.ts';

const DEFAULT_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
const DEFAULT_SSE_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 6365;
const DEFAULT_SSE_PATH = '/sse';
const DEFAULT_STDIO_COMMAND = 'npx';
const DEFAULT_STDIO_ARGS = ['-y', '@jetbrains/mcp-proxy'];
const CLIENT_INFO = { name: 'sagent', version: '1.0.0' };

let sharedClientPromise = null;
let sharedClientKey = '';

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function toAbsolutePath(rawPath, fallback = process.cwd()) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return fallback;
  }
  return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(fallback, rawPath);
}

function parseArgs(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item));
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [...DEFAULT_STDIO_ARGS];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item));
    }
  } catch {
    // ignore JSON parse failure and fall back to whitespace split
  }
  return value.trim().split(/\s+/).filter(Boolean);
}

function truncateText(text, max = 200) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function buildSseUrl(config) {
  if (config.url) {
    return config.url;
  }
  return `http://${config.host}:${config.port}${config.ssePath}`;
}

function buildMessagesUrl(config, streamUrl) {
  if (config.messagesUrl) {
    return config.messagesUrl;
  }
  if (streamUrl.endsWith('/sse')) {
    return `${streamUrl.slice(0, -4)}/messages`;
  }
  return null;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractSchema(tool) {
  return tool?.inputSchema || tool?.input_schema || {};
}

function toolKey(config) {
  return JSON.stringify({
    enabled: config.enabled,
    transport: config.transport,
    url: config.url,
    host: config.host,
    port: config.port,
    ssePath: config.ssePath,
    messagesUrl: config.messagesUrl,
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    projectPath: config.projectPath,
  });
}

export function isIdeMcpEnabled(env = process.env) {
  if (envFlag(env.IDE_MCP_ENABLED)) {
    return true;
  }
  return Boolean(
    env.IDE_MCP_TRANSPORT ||
    env.IDE_MCP_URL ||
    env.IDE_MCP_SSE_URL ||
    env.IDE_MCP_COMMAND ||
    env.IDE_MCP_HOST ||
    env.IDE_MCP_PORT
  );
}

export function buildIdePromptLines(env = process.env) {
  if (!isIdeMcpEnabled(env)) {
    return [];
  }
  return [
    '当 IDE MCP 已启用时，可先使用 ide_list_tools 查看 JetBrains IDE 暴露的 MCP 工具，再用 ide_call_tool 调用具体工具。',
    'ide_call_tool 的 toolName 必须来自 ide_list_tools 返回结果，arguments 传对应参数对象。',
    '如果目标工具支持 projectPath 且未显式传入，系统会自动补上 IDE_PROJECT_PATH 或当前工作目录。',
  ];
}

export function loadIdeMcpConfig(env = process.env) {
  const transport = String(env.IDE_MCP_TRANSPORT || '').trim().toLowerCase() === 'stdio' ? 'stdio' : 'sse';
  const host = String(env.IDE_MCP_HOST || DEFAULT_SSE_HOST).trim() || DEFAULT_SSE_HOST;
  const port = Number(env.IDE_MCP_PORT || DEFAULT_SSE_PORT) || DEFAULT_SSE_PORT;
  const ssePath = String(env.IDE_MCP_SSE_PATH || DEFAULT_SSE_PATH).trim() || DEFAULT_SSE_PATH;
  const projectPath = toAbsolutePath(env.IDE_PROJECT_PATH || env.IDE_MCP_PROJECT_PATH, process.cwd());
  const cwd = toAbsolutePath(env.IDE_MCP_CWD || projectPath, process.cwd());
  const url = String(env.IDE_MCP_URL || env.IDE_MCP_SSE_URL || '').trim() || null;
  const messagesUrl = String(env.IDE_MCP_MESSAGES_URL || '').trim() || null;
  const command = String(env.IDE_MCP_COMMAND || DEFAULT_STDIO_COMMAND).trim() || DEFAULT_STDIO_COMMAND;
  const args = parseArgs(env.IDE_MCP_ARGS);

  return {
    enabled: isIdeMcpEnabled(env),
    transport,
    host,
    port,
    ssePath,
    url,
    messagesUrl,
    command,
    args,
    cwd,
    projectPath,
  };
}

export function applyIdeToolDefaults(args, tool, config = loadIdeMcpConfig()) {
  const normalized = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const schema = extractSchema(tool);
  const properties = schema?.properties || {};
  if (config.projectPath && Object.prototype.hasOwnProperty.call(properties, 'projectPath') && !normalized.projectPath) {
    normalized.projectPath = config.projectPath;
  }
  return normalized;
}

function createJsonRpcError(message, code = -32000, data = null) {
  return {
    jsonrpc: '2.0',
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

class IdeMcpClient {
  config: any;
  transport: any;
  toolsCache: any[] | null;

  constructor(config, transport) {
    this.config = config;
    this.transport = transport;
    this.toolsCache = null;
  }

  async listTools({ refresh = false } = {}) {
    if (!refresh && this.toolsCache) {
      return this.toolsCache;
    }

    const tools = [];
    const seenCursors = new Set();
    let cursor = undefined;

    while (true) {
      const params = cursor ? { cursor } : {};
      const result = await this.transport.request('tools/list', params);
      if (Array.isArray(result?.tools)) {
        tools.push(...result.tools);
      }

      const nextCursor = result?.nextCursor || result?.cursor || null;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    this.toolsCache = tools;
    return tools;
  }

  async getTool(toolName, { refresh = false } = {}) {
    const tools = await this.listTools({ refresh });
    return tools.find(tool => tool?.name === toolName) || null;
  }

  async callTool(toolName, args) {
    return this.transport.request('tools/call', {
      name: toolName,
      arguments: args || {},
    });
  }

  async close() {
    await this.transport.close?.();
  }
}

class StdioTransport {
  config: any;
  child: any;
  buffer: Buffer;
  pending: Map<any, any>;
  nextId: number;
  initialized: boolean;
  connectPromise: Promise<void> | null;
  initializePromise: Promise<void> | null;

  constructor(config) {
    this.config = config;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.connectPromise = null;
    this.initializePromise = null;
  }

  async ensureConnected() {
    if (this.child) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      let settled = false;
      const onError = err => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`启动 IDE MCP stdio 进程失败: ${err.message}`));
      };

      child.once('error', onError);
      child.stdout.on('data', chunk => this.handleStdout(chunk));
      child.stderr.on('data', chunk => {
        log.debug(`[IDE MCP][stderr] ${truncateText(chunk.toString().trim(), 400)}`);
      });
      child.on('exit', (code, signal) => {
        const error = new Error(`IDE MCP stdio 进程已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        this.rejectAllPending(error);
        this.child = null;
        this.initialized = false;
        this.initializePromise = null;
      });

      this.child = child;
      settled = true;
      resolve();
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  handleStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);

    while (true) {
      const headerEnd = this.findHeaderEnd(this.buffer);
      if (headerEnd < 0) {
        return;
      }

      const separatorLength = this.buffer[headerEnd] === 13 ? 4 : 2;
      const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
      const contentLength = this.getContentLength(headerText);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.rejectAllPending(new Error(`IDE MCP 响应缺少 Content-Length: ${headerText}`));
        this.buffer = Buffer.alloc(0);
        return;
      }

      const bodyStart = headerEnd + separatorLength;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const message = JSON.parse(body);
        this.handleIncomingMessage(message);
      } catch (err) {
        this.rejectAllPending(new Error(`IDE MCP 响应 JSON 解析失败: ${err.message}`));
      }
    }
  }

  findHeaderEnd(buffer) {
    const crlf = buffer.indexOf('\r\n\r\n');
    if (crlf >= 0) {
      return crlf;
    }
    return buffer.indexOf('\n\n');
  }

  getContentLength(headerText) {
    const line = headerText
      .split(/\r?\n/)
      .find(item => item.toLowerCase().startsWith('content-length:'));
    if (!line) {
      return NaN;
    }
    return Number(line.split(':')[1]?.trim());
  }

  handleIncomingMessage(message) {
    if (message?.method && message?.id !== undefined) {
      this.sendRaw({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'sagent does not handle server-initiated MCP requests' },
      }).catch(() => {});
      return;
    }

    if (message?.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`IDE MCP 请求失败: ${message.error.message || safeJson(message.error)}`));
        return;
      }
      pending.resolve(message.result);
    }
  }

  rejectAllPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async sendRaw(message) {
    await this.ensureConnected();
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const framed = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(Buffer.concat([framed, payload]), err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async ensureInitialized() {
    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      await this.ensureConnected();

      let lastError = null;
      for (const version of DEFAULT_PROTOCOL_VERSIONS) {
        try {
          await this.sendRequest('initialize', {
            protocolVersion: version,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          }, { skipInit: true });
          await this.sendNotification('notifications/initialized', {});
          this.initialized = true;
          return;
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError || new Error('IDE MCP initialize 失败');
    })().finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  async sendNotification(method, params) {
    await this.sendRaw({
      jsonrpc: '2.0',
      method,
      params: params || {},
    });
  }

  async sendRequest(method, params, { skipInit = false } = {}) {
    if (!skipInit) {
      await this.ensureInitialized();
    }

    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IDE MCP 请求超时: ${method}`));
      }, 15000);

      this.pending.set(id, { resolve, reject, timer });

      try {
        await this.sendRaw({
          jsonrpc: '2.0',
          id,
          method,
          params: params || {},
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async request(method, params) {
    return this.sendRequest(method, params);
  }

  async close() {
    this.rejectAllPending(new Error('IDE MCP 客户端已关闭'));
    try {
      this.child?.kill('SIGTERM');
    } catch {
      // noop
    }
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.initialized = false;
    this.initializePromise = null;
  }
}

class SseTransport {
  config: any;
  streamUrl: string;
  postUrl: string | null;
  pending: Map<any, any>;
  nextId: number;
  initialized: boolean;
  initializePromise: Promise<void> | null;
  streamPromise: Promise<void> | null;
  endpointPromise: Promise<string> | null;
  endpointResolve: ((value: string | PromiseLike<string>) => void) | null;
  endpointReject: ((reason?: any) => void) | null;
  abortController: AbortController | null;

  constructor(config) {
    this.config = config;
    this.streamUrl = buildSseUrl(config);
    this.postUrl = buildMessagesUrl(config, this.streamUrl);
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.initializePromise = null;
    this.streamPromise = null;
    this.endpointPromise = null;
    this.endpointResolve = null;
    this.endpointReject = null;
    this.abortController = null;
  }

  async ensureStreamOpen(): Promise<string> {
    if (this.streamPromise) {
      if (!this.endpointPromise) {
        throw new Error('IDE MCP SSE endpoint 尚未初始化');
      }
      return this.endpointPromise;
    }

    this.endpointPromise = new Promise<string>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });

    if (this.postUrl) {
      this.endpointResolve?.(this.postUrl);
    }

    this.abortController = new AbortController();

    this.streamPromise = fetch(this.streamUrl, {
      headers: { Accept: 'text/event-stream' },
      signal: this.abortController.signal,
    })
      .then(async response => {
        if (!response.ok || !response.body) {
          throw new Error(`SSE 连接失败: HTTP ${response.status}`);
        }
        await this.consumeStream(response.body);
      })
      .catch(err => {
        const error = new Error(`IDE MCP SSE 连接失败: ${err.message}`);
        this.endpointReject?.(error);
        this.rejectAllPending(error);
        throw error;
      })
      .finally(() => {
        this.streamPromise = null;
      });

    if (!this.endpointPromise) {
      throw new Error('IDE MCP SSE endpoint 尚未初始化');
    }
    return this.endpointPromise;
  }

  async consumeStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) {
          break;
        }

        const boundary = match.index;
        const eventBlock = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match[0].length);
        this.handleSseEvent(eventBlock);
      }
    }
  }

  handleSseEvent(block) {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataLines = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message';
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    const data = dataLines.join('\n').trim();
    if (!data) {
      return;
    }

    if (eventName === 'endpoint') {
      this.postUrl = new URL(data, this.streamUrl).toString();
      this.endpointResolve?.(this.postUrl);
      return;
    }

    try {
      const message = JSON.parse(data);
      this.handleIncomingMessage(message);
    } catch (err) {
      log.warn(`[IDE MCP][SSE] 无法解析事件: ${truncateText(data, 240)} (${err.message})`);
    }
  }

  handleIncomingMessage(message) {
    if (message?.method && message?.id !== undefined) {
      this.postJsonRpc({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'sagent does not handle server-initiated MCP requests' },
      }).catch(() => {});
      return;
    }

    if (message?.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`IDE MCP 请求失败: ${message.error.message || safeJson(message.error)}`));
        return;
      }
      pending.resolve(message.result);
    }
  }

  rejectAllPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async postJsonRpc(message) {
    const endpoint = await this.ensureStreamOpen();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${truncateText(body, 240)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await response.json();
      this.handleIncomingMessage(json);
    }
  }

  async ensureInitialized() {
    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      await this.ensureStreamOpen();
      let lastError = null;

      for (const version of DEFAULT_PROTOCOL_VERSIONS) {
        try {
          await this.sendRequest('initialize', {
            protocolVersion: version,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          }, { skipInit: true });
          await this.sendNotification('notifications/initialized', {});
          this.initialized = true;
          return;
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError || new Error('IDE MCP initialize 失败');
    })().finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  async sendNotification(method, params) {
    await this.postJsonRpc({
      jsonrpc: '2.0',
      method,
      params: params || {},
    });
  }

  async sendRequest(method, params, { skipInit = false } = {}) {
    if (!skipInit) {
      await this.ensureInitialized();
    }

    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IDE MCP 请求超时: ${method}`));
      }, 15000);

      this.pending.set(id, { resolve, reject, timer });

      try {
        await this.postJsonRpc({
          jsonrpc: '2.0',
          id,
          method,
          params: params || {},
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async request(method, params) {
    return this.sendRequest(method, params);
  }

  async close() {
    this.abortController?.abort();
    this.abortController = null;
    this.rejectAllPending(new Error('IDE MCP SSE 客户端已关闭'));
    this.initialized = false;
    this.initializePromise = null;
    this.streamPromise = null;
  }
}

export function createIdeMcpClient(config = loadIdeMcpConfig()) {
  if (!config.enabled) {
    throw new Error('IDE MCP 未启用，请在 .env 中设置 IDE_MCP_ENABLED=true');
  }

  const transport = config.transport === 'stdio'
    ? new StdioTransport(config)
    : new SseTransport(config);

  return new IdeMcpClient(config, transport);
}

export async function getSharedIdeMcpClient(config = loadIdeMcpConfig()) {
  const key = toolKey(config);
  if (sharedClientPromise && sharedClientKey === key) {
    return sharedClientPromise;
  }

  if (sharedClientPromise && sharedClientKey !== key) {
    try {
      const existing = await sharedClientPromise;
      await existing.close();
    } catch {
      // noop
    }
  }

  sharedClientKey = key;
  sharedClientPromise = Promise.resolve(createIdeMcpClient(config));
  return sharedClientPromise;
}

export async function resetIdeMcpClientForTests() {
  if (!sharedClientPromise) {
    sharedClientKey = '';
    return;
  }
  try {
    const client = await sharedClientPromise;
    await client.close();
  } catch {
    // noop
  } finally {
    sharedClientPromise = null;
    sharedClientKey = '';
  }
}

export function formatIdeMcpError(error, context = '') {
  const prefix = context ? `${context}: ` : '';
  return `${prefix}${error?.message || safeJson(error)}`;
}

export function summarizeIdeTool(tool) {
  const schema = extractSchema(tool);
  const properties = schema?.properties || {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields = Object.keys(properties)
    .map(name => `${name}${required.has(name) ? '*' : ''}`)
    .join(', ');

  return {
    name: tool?.name || '',
    description: tool?.description || '',
    fields,
  };
}

export function serializeIdePayload(value) {
  return safeJson(value);
}

export function buildUnsupportedServerRequest(method) {
  return createJsonRpcError(`sagent does not implement server request: ${method}`, -32601);
}
