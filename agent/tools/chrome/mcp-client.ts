import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { log } from '../../../helpers/logger.ts';

const DEFAULT_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
const DEFAULT_SSE_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3099;
const DEFAULT_SSE_PATH = '/sse';
const SSE_ENDPOINT_WAIT_MS = 250;
const DEFAULT_STDIO_COMMAND = 'npx';
const DEFAULT_STDIO_ARGS = ['-y', 'chrome-devtools-mcp@latest'];
const CLIENT_INFO = { name: 'sagent', version: '1.0.0' };
const IS_WINDOWS = process.platform === 'win32';

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

function resolveCommandOnWindows(command, args) {
  if (!IS_WINDOWS) {
    return { command, args };
  }
  if (path.extname(command)) {
    return { command, args };
  }
  const binDir = path.resolve('node_modules', '.bin');
  const base = path.basename(command);
  const cmdPath = path.join(binDir, base + '.cmd');
  if (!fs.existsSync(cmdPath)) {
    return { command, args };
  }
  const pkgJs = path.resolve('node_modules', base, 'build', 'src', 'bin', base + '.js');
  if (fs.existsSync(pkgJs)) {
    return { command: 'node', args: [pkgJs, ...args] };
  }
  return { command, args };
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

export function buildSsePostCandidates(config, streamUrl) {
  const candidates = [];
  const seen = new Set();

  const push = value => {
    const normalized = typeof value === 'string' && value.trim() ? value.trim() : '';
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  push(config.messagesUrl);

  if (streamUrl.endsWith('/sse')) {
    const base = streamUrl.slice(0, -4);
    push(`${base}/message`);
    push(`${base}/messages`);
    push(`${base}/mcp`);
  }

  push(buildMessagesUrl(config, streamUrl));
  return candidates;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeRpcParams(params, max = 600) {
  return truncateText(safeJson(params || {}), max);
}

function summarizeRpcMessage(message, max = 800) {
  return truncateText(safeJson(message || {}), max);
}

function logChromeRequest(transport, target, method, params, extra = '') {
  log.info(`[Chrome MCP][${transport}] -> ${target} method=${method}${extra ? ` ${extra}` : ''} params=${summarizeRpcParams(params)}`);
}

function logChromeResponse(transport, target, method, status, body = '') {
  const suffix = body ? ` body=${truncateText(body, 400)}` : '';
  log.info(`[Chrome MCP][${transport}] <- ${target} method=${method} status=${status}${suffix}`);
}

function logChromeInboundEvent(transport, eventName, data) {
  log.info(`[Chrome MCP][${transport}] event=${eventName} data=${truncateText(data, 500)}`);
}

function logChromeInboundMessage(transport, message) {
  if (message?.error) {
    log.info(`[Chrome MCP][${transport}] inbound error id=${message.id ?? 'n/a'} payload=${summarizeRpcMessage(message.error, 600)}`);
    return;
  }
  if (message?.result !== undefined) {
    log.info(`[Chrome MCP][${transport}] inbound result id=${message.id ?? 'n/a'} payload=${summarizeRpcMessage(message.result, 1000)}`);
    return;
  }
  log.info(`[Chrome MCP][${transport}] inbound payload=${summarizeRpcMessage(message, 1000)}`);
}

function extractSchema(tool) {
  return tool?.inputSchema || tool?.input_schema || {};
}

function clientKey(config) {
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
  });
}

export function isChromeMcpEnabled(env = process.env) {
  if (envFlag(env.CHROME_MCP_ENABLED)) {
    return true;
  }
  return Boolean(
    env.CHROME_MCP_TRANSPORT ||
    env.CHROME_MCP_URL ||
    env.CHROME_MCP_COMMAND ||
    env.CHROME_MCP_HOST ||
    env.CHROME_MCP_PORT
  );
}

export function buildChromePromptLines(env = process.env) {
  if (!isChromeMcpEnabled(env)) {
    return [];
  }
  return [
    '当 Chrome DevTools MCP 已启用时，可先使用 chrome_list_tools 查看 Chrome DevTools 暴露的 MCP 工具，再用 chrome_call_tool 调用具体工具。',
    'chrome_call_tool 的 toolName 必须来自 chrome_list_tools 返回结果，arguments 传对应参数对象。',
    'Chrome DevTools 工具可用于浏览器页面操作、截图、网络请求检查、性能分析等。',
  ];
}

export function loadChromeMcpConfig(env = process.env) {
  const transport = String(env.CHROME_MCP_TRANSPORT || '').trim().toLowerCase() === 'stdio' ? 'stdio' : 'sse';
  const host = String(env.CHROME_MCP_HOST || DEFAULT_SSE_HOST).trim() || DEFAULT_SSE_HOST;
  const port = Number(env.CHROME_MCP_PORT || DEFAULT_SSE_PORT) || DEFAULT_SSE_PORT;
  const ssePath = String(env.CHROME_MCP_SSE_PATH || DEFAULT_SSE_PATH).trim() || DEFAULT_SSE_PATH;
  const cwd = toAbsolutePath(env.CHROME_MCP_CWD, process.cwd());
  const url = String(env.CHROME_MCP_URL || '').trim() || null;
  const messagesUrl = String(env.CHROME_MCP_MESSAGES_URL || '').trim() || null;
  const command = String(env.CHROME_MCP_COMMAND || DEFAULT_STDIO_COMMAND).trim() || DEFAULT_STDIO_COMMAND;
  const args = parseArgs(env.CHROME_MCP_ARGS);

  return {
    enabled: isChromeMcpEnabled(env),
    transport,
    host,
    port,
    ssePath,
    url,
    messagesUrl,
    command,
    args,
    cwd,
  };
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

class ChromeMcpClient {
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

  async callTool(toolName, toolArgs) {
    const doCall = async () => this.transport.request('tools/call', {
      name: toolName,
      arguments: toolArgs || {},
    });

    try {
      const result = await doCall();
      // MCP returns tool errors as { isError: true } in a successful JSON-RPC response,
      // not as a JSON-RPC error — so we must check result.isError explicitly.
      if (result?.isError && this._isChromeConnectionResult(result)) {
        return await this._retryWithoutAutoConnect(toolName, toolArgs);
      }
      return result;
    } catch (err) {
      if (this._isChromeConnectionError(err)) {
        return await this._retryWithoutAutoConnect(toolName, toolArgs);
      }
      throw err;
    }
  }

  async _retryWithoutAutoConnect(toolName, toolArgs) {
    if (!this._stripAutoConnect()) {
      throw new Error('Chrome MCP 连接失败且无法回退');
    }
    log.info(`[Chrome MCP] 工具调用 ${toolName} 连接失败，移除 --autoConnect 重试（将自动启动浏览器）`);
    const client = await getSharedChromeMcpClient(this.config);

    // Without --autoConnect, the MCP server launches Chrome in the background.
    // Chrome needs time to start, so retry the tool call on error.
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3000;

    for (let attempt = 0; ; attempt++) {
      const result = await client.transport.request('tools/call', {
        name: toolName,
        arguments: toolArgs || {},
      });

      if (!result?.isError) {
        return result;
      }

      if (attempt >= MAX_RETRIES - 1) {
        log.info(`[Chrome MCP] 工具调用 ${toolName} 浏览器启动后仍失败（已重试 ${MAX_RETRIES} 次）`);
        return result;
      }

      log.info(`[Chrome MCP] 等待浏览器启动，${RETRY_DELAY_MS}ms 后重试 ${toolName}（第 ${attempt + 1}/${MAX_RETRIES} 次）`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  _isChromeConnectionResult(result) {
    const text = Array.isArray(result?.content)
      ? result.content.map(c => c?.text || '').join(' ')
      : '';
    return text.includes('Could not connect to Chrome')
      || text.includes('DevToolsActivePort')
      || text.includes('Could not find');
  }

  _isChromeConnectionError(err) {
    const msg = err?.message || '';
    return msg.includes('Could not connect to Chrome')
      || msg.includes('DevToolsActivePort')
      || msg.includes('Could not find');
  }

  _stripAutoConnect() {
    const config = this.transport?.config;
    if (!config || !Array.isArray(config.args) || !config.args.includes('--autoConnect')) {
      return false;
    }
    config.args = config.args.filter(a => a !== '--autoConnect');
    // Close and reset so the next request spawns a fresh MCP process without --autoConnect
    this.transport.close?.().catch(() => {});
    this.toolsCache = null;
    sharedClientPromise = null;
    sharedClientKey = '';
    return true;
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
    if (this.child && !this.child.stdin?.destroyed) {
      return;
    }
    if (this.child?.stdin?.destroyed) {
      this.child = null;
      this.initialized = false;
      this.initializePromise = null;
      this.connectPromise = null;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      log.info(`[Chrome MCP][stdio] spawn command=${this.config.command} args=${safeJson(this.config.args)} cwd=${this.config.cwd}`);
      const resolved = resolveCommandOnWindows(this.config.command, this.config.args);
      const child = spawn(resolved.command, resolved.args, {
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
        reject(new Error(`启动 Chrome MCP stdio 进程失败: ${err.message}`));
      };

      child.once('error', onError);
      child.stdout.on('data', chunk => this.handleStdout(chunk));
      child.stderr.on('data', chunk => {
        log.warn(`[Chrome MCP][stderr] ${truncateText(chunk.toString().trim(), 400)}`);
      });
      child.on('exit', (code, signal) => {
        const error = new Error(`Chrome MCP stdio 进程已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        this.rejectAllPending(error);
        this.child = null;
        this.initialized = false;
        this.initializePromise = null;
        this.connectPromise = null;
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

    while (this.buffer.length > 0) {
      const text = this.buffer.toString('utf8');

      // Try Content-Length framing first
      if (text.startsWith('Content-Length:') || text.startsWith('content-length:')) {
        const headerEnd = this.findHeaderEnd(this.buffer);
        if (headerEnd < 0) return;

        const separatorLength = this.buffer[headerEnd] === 13 ? 4 : 2;
        const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
        const contentLength = this.getContentLength(headerText);
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          log.warn(`[Chrome MCP][stdio] 无效 Content-Length header: ${truncateText(headerText, 200)}`);
          this.buffer = Buffer.alloc(0);
          return;
        }

        const bodyStart = headerEnd + separatorLength;
        const bodyEnd = bodyStart + contentLength;
        if (this.buffer.length < bodyEnd) return;

        const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
        this.buffer = this.buffer.slice(bodyEnd);

        try {
          const message = JSON.parse(body);
          this.handleIncomingMessage(message);
        } catch (err) {
          log.warn(`[Chrome MCP][stdio] JSON 解析失败: ${err.message}`);
        }
        continue;
      }

      // Fallback: newline-delimited JSON (NDJSON)
      const newlineIdx = text.indexOf('\n');
      if (newlineIdx < 0) return;

      const line = text.slice(0, newlineIdx).trim();
      this.buffer = Buffer.from(text.slice(newlineIdx + 1), 'utf8');

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this.handleIncomingMessage(message);
      } catch (err) {
        log.warn(`[Chrome MCP][stdio] NDJSON 解析失败: ${truncateText(line, 200)}`);
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
        pending.reject(new Error(`Chrome MCP 请求失败: ${message.error.message || safeJson(message.error)}`));
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
    if (!this.child || this.child.stdin?.destroyed) {
      throw new Error('Chrome MCP stdio 连接已断开，请重试');
    }
    const payload = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(payload, err => {
        if (err) {
          if (err.code === 'ERR_STREAM_DESTROYED') {
            this.child = null;
            this.initialized = false;
            this.initializePromise = null;
          }
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

      // If --autoConnect was used and failed, retry without it so the MCP server
      // launches its own Chrome instance in the background
      if (this.config.args?.includes('--autoConnect')) {
        log.info('[Chrome MCP][stdio] --autoConnect 连接失败，移除该参数重试（将自动启动浏览器）');
        await this.close();
        this.config = { ...this.config, args: this.config.args.filter(a => a !== '--autoConnect') };
        await this.ensureConnected();

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
      }

      throw lastError || new Error('Chrome MCP initialize 失败');
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
    logChromeRequest('stdio', 'stdio', method, params, `id=${id}`);
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome MCP 请求超时: ${method}`));
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
    this.rejectAllPending(new Error('Chrome MCP 客户端已关闭'));
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
  fallbackPostUrls: string[];
  pending: Map<any, any>;
  nextId: number;
  initialized: boolean;
  initializePromise: Promise<void> | null;
  streamPromise: Promise<void> | null;
  endpointPromise: Promise<string> | null;
  endpointResolve: ((value: string | PromiseLike<string>) => void) | null;
  endpointReject: ((reason?: any) => void) | null;
  abortController: AbortController | null;
  endpointFallbackTimer: ReturnType<typeof setTimeout> | null;

  constructor(config) {
    this.config = config;
    this.streamUrl = buildSseUrl(config);
    this.postUrl = config.messagesUrl || null;
    this.fallbackPostUrls = buildSsePostCandidates(config, this.streamUrl);
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.initializePromise = null;
    this.streamPromise = null;
    this.endpointPromise = null;
    this.endpointResolve = null;
    this.endpointReject = null;
    this.abortController = null;
    this.endpointFallbackTimer = null;
  }

  async ensureStreamOpen(): Promise<string> {
    if (this.streamPromise) {
      if (!this.endpointPromise) {
        throw new Error('Chrome MCP SSE endpoint 尚未初始化');
      }
      return this.endpointPromise;
    }

    this.endpointPromise = new Promise<string>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });

    if (this.postUrl) {
      this.endpointResolve?.(this.postUrl);
    } else if (this.fallbackPostUrls[0]) {
      this.endpointFallbackTimer = setTimeout(() => {
        if (!this.postUrl && this.fallbackPostUrls[0]) {
          this.endpointResolve?.(this.fallbackPostUrls[0]);
        }
      }, SSE_ENDPOINT_WAIT_MS);
    }

    this.abortController = new AbortController();
    log.info(`[Chrome MCP][sse] opening stream url=${this.streamUrl} fallbackPostUrls=${safeJson(this.fallbackPostUrls)}`);

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
        const error = new Error(`Chrome MCP SSE 连接失败: ${err.message}`);
        log.warn(`[Chrome MCP][sse] stream failed url=${this.streamUrl} reason=${error.message}`);
        this.endpointReject?.(error);
        this.rejectAllPending(error);
        return;
      })
      .finally(() => {
        log.info(`[Chrome MCP][sse] stream closed url=${this.streamUrl}`);
        this.streamPromise = null;
      });

    if (!this.endpointPromise) {
      throw new Error('Chrome MCP SSE endpoint 尚未初始化');
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

    logChromeInboundEvent('sse', eventName, data);

    if (eventName === 'endpoint') {
      if (this.endpointFallbackTimer) {
        clearTimeout(this.endpointFallbackTimer);
        this.endpointFallbackTimer = null;
      }
      this.postUrl = new URL(data, this.streamUrl).toString();
      log.info(`[Chrome MCP][sse] endpoint event -> ${this.postUrl}`);
      this.endpointResolve?.(this.postUrl);
      return;
    }

    try {
      const message = JSON.parse(data);
      logChromeInboundMessage('sse', message);
      this.handleIncomingMessage(message);
    } catch (err) {
      log.warn(`[Chrome MCP][SSE] 无法解析事件: ${truncateText(data, 240)} (${err.message})`);
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
        pending.reject(new Error(`Chrome MCP 请求失败: ${message.error.message || safeJson(message.error)}`));
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
    const candidates = [endpoint, this.postUrl, ...this.fallbackPostUrls]
      .filter((value, index, array) => typeof value === 'string' && value && array.indexOf(value) === index);

    let lastError = null;
    const method = message?.method || 'unknown';
    const params = message?.params || {};

    for (const candidate of candidates) {
      logChromeRequest('sse', candidate, method, params, message?.id !== undefined ? `id=${message.id}` : 'notification=true');
      const response = await fetch(candidate, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logChromeResponse('sse', candidate, method, response.status, body);
        lastError = new Error(`HTTP ${response.status}: ${truncateText(body, 240)}`);
        if (response.status === 404) {
          continue;
        }
        throw lastError;
      }

      this.postUrl = candidate;
      logChromeResponse('sse', candidate, method, response.status);
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await response.json();
        log.info(`[Chrome MCP][sse] json response method=${method} payload=${summarizeRpcMessage(json)}`);
        this.handleIncomingMessage(json);
      }
      return;
    }

    throw lastError || new Error('Chrome MCP SSE 消息发送失败');
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

      throw lastError || new Error('Chrome MCP initialize 失败');
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
        reject(new Error(`Chrome MCP 请求超时: ${method}`));
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
    if (this.endpointFallbackTimer) {
      clearTimeout(this.endpointFallbackTimer);
      this.endpointFallbackTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.rejectAllPending(new Error('Chrome MCP SSE 客户端已关闭'));
    this.initialized = false;
    this.initializePromise = null;
    this.streamPromise = null;
  }
}

export function createChromeMcpClient(config = loadChromeMcpConfig()) {
  if (!config.enabled) {
    throw new Error('Chrome MCP 未启用，请在 .env 中设置 CHROME_MCP_ENABLED=true');
  }

  const transport = config.transport === 'stdio'
    ? new StdioTransport(config)
    : new SseTransport(config);

  return new ChromeMcpClient(config, transport);
}

export async function getSharedChromeMcpClient(config = loadChromeMcpConfig()) {
  // Reuse existing client even if config key differs (e.g. _stripAutoConnect removed
  // --autoConnect at runtime but loadChromeMcpConfig() re-reads it from .env).
  if (sharedClientPromise) {
    return sharedClientPromise;
  }
  const key = clientKey(config);

  if (sharedClientPromise && sharedClientKey !== key) {
    try {
      const existing = await sharedClientPromise;
      await existing.close();
    } catch {
      // noop
    }
  }

  sharedClientKey = key;
  sharedClientPromise = Promise.resolve(createChromeMcpClient(config));
  return sharedClientPromise;
}

export async function resetChromeMcpClientForTests() {
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

export function formatChromeMcpError(error, context = '') {
  const prefix = context ? `${context}: ` : '';
  return `${prefix}${error?.message || safeJson(error)}`;
}

export function summarizeChromeTool(tool) {
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

export function serializeChromePayload(value) {
  return safeJson(value);
}
