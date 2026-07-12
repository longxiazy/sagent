import path from 'node:path';
import fs from 'node:fs';
import { log } from '../../../helpers/logger.ts';
import { runtimeConfig } from '../../core/runtime-config.ts';

const DEFAULT_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
const DEFAULT_SSE_HOST = '127.0.0.1';
const DEFAULT_SSE_PORT = 3099;
const DEFAULT_SSE_PATH = '/sse';
const SSE_ENDPOINT_WAIT_MS = 250;

// tools/call 默认 15s 对 navigate_page 等浏览器操作太短；不同工具用不同上限。
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const SLOW_TOOLS = new Set([
  'navigate_page',
  'new_page',
  'wait_for',
  'performance_start_trace',
  'performance_stop_trace',
  'lighthouse_audit',
  'take_memory_snapshot',
]);

function timeoutForRequest(method: string, params: any, longToolTimeoutMs = 60000): number {
  if (method !== 'tools/call') return DEFAULT_REQUEST_TIMEOUT_MS;
  const toolName = params?.name;
  if (SLOW_TOOLS.has(toolName)) {
    // wait_for 自带 timeout 参数；给客户端留 5s 余量，保证服务端先超时
    const argTimeout = Number(params?.arguments?.timeout);
    if (Number.isFinite(argTimeout) && argTimeout > 0) {
      return Math.max(longToolTimeoutMs, argTimeout + 5000);
    }
    return longToolTimeoutMs;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}
const CLIENT_INFO = { name: 'sagent', version: '1.0.0' };

// 幂等工具白名单：客户端超时时可以原地重试。其余工具（click/fill/navigate_page/
// press_key 等）哪怕看起来 timeout，底层 CDP 操作很可能已经发到 Chrome，重试
// 会让浏览器收到两份相同动作；bridge 当前也未把 notifications/cancelled 透传给
// chrome-devtools-mcp，第一次 timeout 后服务端动作不会被真正取消。
const IDEMPOTENT_RETRY_TOOLS = new Set([
  'take_snapshot',
  'take_screenshot',
  'list_pages',
  'list_console_messages',
  'list_network_requests',
  'get_network_request',
  'performance_analyze_insight',
  'wait_for',
]);

let sharedClientPromise = null;
let sharedClientKey = '';

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
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
  // 不同 MCP SSE 实现使用 /message、/messages 或事件下发 endpoint。
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
    transport: 'sse',
    url: config.url,
    host: config.host,
    port: config.port,
    ssePath: config.ssePath,
    messagesUrl: config.messagesUrl,
  });
}

export function isChromeMcpEnabled(env = process.env) {
  const configured = runtimeConfig.mcpServers().chrome;
  if (configured) return configured.enabled;
  // 显式开关优先；只要配置了任一连接参数，也视为用户想启用 Chrome MCP。
  if (envFlag(env.CHROME_MCP_ENABLED)) {
    return true;
  }
  return Boolean(
    env.CHROME_MCP_TRANSPORT ||
    env.CHROME_MCP_URL ||
    env.CHROME_MCP_HOST ||
    env.CHROME_MCP_PORT
  );
}

const CHROME_TOOLS_CACHE_FILE = path.join(process.cwd(), 'data', 'chrome-mcp-tools.json');

function readChromeToolsCacheFromDisk(): any[] | null {
  try {
    if (!fs.existsSync(CHROME_TOOLS_CACHE_FILE)) return null;
    const raw = fs.readFileSync(CHROME_TOOLS_CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.tools) ? data.tools : null;
  } catch {
    return null;
  }
}

function writeChromeToolsCacheToDisk(tools: any[]) {
  try {
    fs.mkdirSync(path.dirname(CHROME_TOOLS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(
      CHROME_TOOLS_CACHE_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), tools }, null, 2),
      'utf8',
    );
  } catch (err: any) {
    log.info(`[Chrome MCP] 保存工具缓存失败: ${err?.message || err}`);
  }
}

export function buildChromePromptLines(env = process.env) {
  if (!isChromeMcpEnabled(env)) {
    return [];
  }
  const lines = [
    '当 Chrome DevTools MCP 已启用时，使用 chrome_call_tool 调用具体工具；toolName 取自下方工具列表，arguments 传对应参数对象。',
    'Chrome DevTools 工具可用于浏览器页面操作、截图、网络请求检查、性能分析等。',
    '只有当怀疑工具列表已变更（例如调用报"未找到 Chrome 工具"）时，才需要 chrome_list_tools 主动刷新；正常情况下直接使用 chrome_call_tool。',
    'uid 形如 "3_12"，下划线前的数字是 snapshotId。每次 take_snapshot（或带 includeSnapshot 的操作）后 snapshotId 都会变，旧 uid 立即失效——禁止跨 snapshot 复用 uid，使用前请取最新 snapshot。',
    'take_snapshot / take_screenshot 只对"当前已选中的页面"生效，需先用 navigate_page(url=...) 打开目标页面；navigate_page 成功后已自动附带页面快照，无需再单独 take_snapshot。',
  ];
  const cachedTools = readChromeToolsCacheFromDisk();
  if (cachedTools && cachedTools.length) {
    const items = cachedTools.map(tool => {
      const summary = summarizeChromeTool(tool);
      const args = summary.fields ? ` (${summary.fields})` : '';
      return `- ${summary.name}${args}`;
    });
    lines.push(`已缓存的 Chrome MCP 工具（共 ${cachedTools.length}）：\n${items.join('\n')}`);
  }
  return lines;
}

export function loadChromeMcpConfig(env = process.env) {
  const configured = runtimeConfig.mcpServers().chrome;
  if (configured) {
    const transport = configured.transport;
    return {
      enabled: configured.enabled,
      transport: transport.type,
      url: transport.type === 'sse' ? transport.url : null,
      messagesUrl: transport.type === 'sse' ? transport.messagesUrl || null : null,
      host: DEFAULT_SSE_HOST,
      port: DEFAULT_SSE_PORT,
      ssePath: DEFAULT_SSE_PATH,
      toolTimeoutMs: configured.toolTimeoutMs || 60000,
      navigateTimeoutMs: configured.navigateTimeoutMs || 25000,
      keepOpen: configured.keepOpen === true,
      keepTabs: configured.keepTabs === true,
      source: 'config',
    };
  }
  const host = String(env.CHROME_MCP_HOST || DEFAULT_SSE_HOST).trim() || DEFAULT_SSE_HOST;
  const port = Number(env.CHROME_MCP_PORT || DEFAULT_SSE_PORT) || DEFAULT_SSE_PORT;
  const ssePath = String(env.CHROME_MCP_SSE_PATH || DEFAULT_SSE_PATH).trim() || DEFAULT_SSE_PATH;
  const url = String(env.CHROME_MCP_URL || '').trim() || null;
  const messagesUrl = String(env.CHROME_MCP_MESSAGES_URL || '').trim() || null;

  return {
    enabled: isChromeMcpEnabled(env),
    transport: 'sse',
    host,
    port,
    ssePath,
    url,
    messagesUrl,
    toolTimeoutMs: Number(env.CHROME_MCP_TOOL_TIMEOUT_MS) || 60000,
    navigateTimeoutMs: Number(env.CHROME_MCP_NAVIGATE_TIMEOUT_MS) || 25000,
    keepOpen: env.CHROME_MCP_KEEP_OPEN === 'true',
    keepTabs: env.CHROME_MCP_KEEP_TABS === 'true',
    source: 'env',
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

  async listTools({ refresh = false, signal = undefined } = {}) {
    if (!refresh && this.toolsCache) {
      return this.toolsCache;
    }
    if (!refresh && !this.toolsCache) {
      const persisted = readChromeToolsCacheFromDisk();
      if (persisted && persisted.length) {
        this.toolsCache = persisted;
        return persisted;
      }
    }

    const tools = [];
    const seenCursors = new Set();
    let cursor = undefined;

    while (true) {
      const params = cursor ? { cursor } : {};
      const result = await this.transport.request('tools/list', params, { signal });
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
    if (tools.length) {
      writeChromeToolsCacheToDisk(tools);
    }
    return tools;
  }

  async getTool(toolName, { refresh = false, signal = undefined } = {}) {
    const tools = await this.listTools({ refresh, signal });
    const found = tools.find(tool => tool?.name === toolName) || null;
    if (found || refresh) {
      return found;
    }
    const refreshed = await this.listTools({ refresh: true, signal });
    return refreshed.find(tool => tool?.name === toolName) || null;
  }

  async callTool(toolName, toolArgs, { signal = undefined } = {}) {
    try {
      return await this.transport.request('tools/call', {
        name: toolName,
        arguments: toolArgs || {},
      }, { signal });
    } catch (err) {
      if (this._isClientTimeoutError(err) && IDEMPOTENT_RETRY_TOOLS.has(toolName)) {
        return await this._retryAfterClientTimeout(toolName, toolArgs, err, signal);
      }
      throw err;
    }
  }

  _isClientTimeoutError(err) {
    return (err?.message || '').startsWith('Chrome MCP 请求超时');
  }

  async _retryAfterClientTimeout(toolName, toolArgs, originalError, signal?: AbortSignal) {
    log.info(`[Chrome MCP] 工具调用 ${toolName} 客户端超时，原地重试一次`);
    await new Promise(r => setTimeout(r, 1500));
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Agent 已取消');
    try {
      return await this.transport.request('tools/call', {
        name: toolName,
        arguments: toolArgs || {},
      }, { signal });
    } catch (retryErr: any) {
      if (this._isClientTimeoutError(retryErr)) {
        throw originalError;
      }
      throw retryErr;
    }
  }

  async close() {
    await this.transport.close?.();
  }
}

// 连接外部 MCP SSE server：GET 订阅事件流，POST 发送 JSON-RPC 消息。
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
    // SSE server 可能通过 endpoint 事件告知 POST 地址；否则短暂等待后用候选地址。
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
    // SSE 事件以空行分隔；每个完整事件块交给 handleSseEvent 解析。
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
    // endpoint 事件更新 POST 地址；普通 message 事件承载 JSON-RPC payload。
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
    // 某些 server 的 messages 路径不同，404 时尝试下一个候选地址。
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
    // SSE transport 初始化后才允许发送普通 MCP 请求。
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

  async sendRequest(method, params, { skipInit = false, signal = undefined } = {}) {
    if (!skipInit) {
      await this.ensureInitialized();
    }

    const id = this.nextId++;
    const timeoutMs = timeoutForRequest(method, params, this.config.toolTimeoutMs);
    return new Promise(async (resolve, reject) => {
      const cancelRequest = (reason: string) => this.sendNotification('notifications/cancelled', {
        requestId: id,
        reason,
      }).catch(() => {});
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        cancelRequest('parent AbortSignal aborted');
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Agent 已取消'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        // MCP 规范：超时时主动通知服务端取消 in-flight 请求，避免悬挂的 CDP 操作继续动 Chrome。
        this.sendNotification('notifications/cancelled', {
          requestId: id,
          reason: `client timeout after ${timeoutMs}ms`,
        }).catch(() => { /* SSE 通道可能已断；通知失败不影响主流程 */ });
        reject(new Error(`Chrome MCP 请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: err => { cleanup(); reject(err); },
        timer,
      });

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
        cleanup();
        reject(err);
      }
    });
  }

  async request(method, params, options = {}) {
    return this.sendRequest(method, params, options);
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
  if (config.transport !== 'sse') {
    throw new Error(`Chrome MCP 暂不支持 transport=${config.transport}`);
  }

  return new ChromeMcpClient(config, new SseTransport(config));
}

export async function getSharedChromeMcpClient(config = loadChromeMcpConfig()) {
  const key = clientKey(config);

  if (sharedClientPromise && sharedClientKey === key) {
    return sharedClientPromise;
  }

  if (sharedClientPromise) {
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

export async function closeAllChromePagesQuiet(): Promise<void> {
  // run 结束/异常时尽力关闭本次 run 期间打开的 Chrome tab；任何步骤失败都吞错，
  // 不阻断 shutdownChromeMcp 等后续 cleanup。sharedClientPromise 为空说明本进程
  // 从未连过 bridge，没什么要关的。chrome-devtools-mcp 不允许关最后一个 page，
  // 那次 close_page 调用会被它内部吞掉，正好留一个空白 tab 兜底。
  if (!sharedClientPromise) return;
  let client: any;
  try {
    client = await sharedClientPromise;
  } catch {
    return;
  }
  let listResult: any;
  try {
    listResult = await client.callTool('list_pages', {});
  } catch {
    return;
  }
  if (!listResult || listResult.isError) return;
  const text = Array.isArray(listResult.content)
    ? listResult.content.map((c: any) => (c?.type === 'text' && c.text) ? c.text : '').join('\n')
    : '';
  const pageIds: number[] = [];
  for (const m of text.matchAll(/^\s*(\d+):\s*\S+/gm)) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && !pageIds.includes(id)) pageIds.push(id);
  }
  // 倒序关：让"最后那个保留 tab"是 id 最小的（通常是首个 about:blank/启动页），
  // chrome-devtools-mcp 拒掉最后一个 close 也不影响其余 tab 的清理。
  pageIds.sort((a, b) => b - a);
  for (const pageId of pageIds) {
    try {
      await client.callTool('close_page', { pageId });
    } catch {
      // ignore
    }
  }
}

export async function shutdownChromeMcp(): Promise<void> {
  // run 结束时只关闭本进程里的 SSE client；外部 chrome:mcp bridge 自己管理 Chrome 生命周期。
  if (sharedClientPromise) {
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
