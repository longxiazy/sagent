#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3099;
const require = createRequire(import.meta.url);

function resolveChromeMcpBin() {
  try {
    const packageJson = require.resolve('chrome-devtools-mcp/package.json');
    return path.join(path.dirname(packageJson), 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
  } catch (err) {
    throw new Error(`无法解析 chrome-devtools-mcp，请先运行 npm install: ${err?.message || err}`);
  }
}

const DEFAULT_COMMAND = process.execPath;
const DEFAULT_COMMAND_ARGS = [resolveChromeMcpBin()];

function parseFlag(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function parseChildArgs() {
  const passthrough = process.argv.indexOf('--');
  if (passthrough >= 0) {
    return process.argv.slice(passthrough + 1);
  }
  const raw = process.env.CHROME_MCP_BRIDGE_ARGS || '';
  if (!raw.trim()) return ['--isolated', '--no-usage-statistics', '--no-performance-crux'];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw.trim().split(/\s+/).filter(Boolean);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class StdioMcpBridge {
  constructor(command, args) {
    this.command = command;
    this.args = args;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  failChild(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child = null;
  }

  start() {
    if (this.child && !this.child.killed) return;
    console.log(`[chrome-mcp-sse] spawn ${this.command} ${this.args.join(' ')}`);
    this.child = spawn(this.command, this.args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child.stdout.on('data', chunk => this.handleStdout(chunk));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) console.error(`[chrome-mcp] ${text}`);
    });
    this.child.on('error', err => {
      this.failChild(new Error(`启动 chrome-devtools-mcp 失败: ${err.message}`));
    });
    this.child.on('exit', (code, signal) => {
      this.failChild(new Error(`chrome-devtools-mcp exited code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  }

  send(message) {
    this.start();
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('chrome-devtools-mcp stdin is not available');
    }
    this.child.stdin.write(`${safeJson(message)}\n`);
  }

  request(message) {
    if (message?.id === undefined) {
      this.send(message);
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      try {
        this.send(message);
      } catch (err) {
        this.pending.delete(message.id);
        reject(err);
      }
    });
  }

  handleStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length) {
      const text = this.buffer.toString('utf8');
      if (text.toLowerCase().startsWith('content-length:')) {
        const headerEnd = this.findHeaderEnd(this.buffer);
        if (headerEnd < 0) return;
        const separatorLength = this.buffer[headerEnd] === 13 ? 4 : 2;
        const header = this.buffer.slice(0, headerEnd).toString('utf8');
        const contentLength = this.getContentLength(header);
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          this.buffer = Buffer.alloc(0);
          return;
        }
        const bodyStart = headerEnd + separatorLength;
        const bodyEnd = bodyStart + contentLength;
        if (this.buffer.length < bodyEnd) return;
        const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
        this.buffer = this.buffer.slice(bodyEnd);
        this.handleMessage(body);
        continue;
      }

      const newlineIdx = text.indexOf('\n');
      if (newlineIdx < 0) return;
      const line = text.slice(0, newlineIdx).trim();
      this.buffer = Buffer.from(text.slice(newlineIdx + 1), 'utf8');
      if (line) this.handleMessage(line);
    }
  }

  findHeaderEnd(buffer) {
    const crlf = buffer.indexOf('\r\n\r\n');
    if (crlf >= 0) return crlf;
    return buffer.indexOf('\n\n');
  }

  getContentLength(header) {
    const line = header.split(/\r?\n/).find(item => item.toLowerCase().startsWith('content-length:'));
    return Number(line?.split(':')[1]?.trim());
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      console.error(`[chrome-mcp-sse] ignored non-json stdout: ${raw.slice(0, 200)}`);
      return;
    }

    if (message?.method && message?.id !== undefined) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'bridge does not handle server-initiated requests' },
      });
      return;
    }

    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  stop() {
    this.child?.kill('SIGTERM');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const host = parseFlag('host', process.env.CHROME_MCP_BRIDGE_HOST || DEFAULT_HOST);
const port = Number(parseFlag('port', process.env.CHROME_MCP_BRIDGE_PORT || DEFAULT_PORT));
const explicitCommand = parseFlag('command', process.env.CHROME_MCP_BRIDGE_COMMAND || '');
const command = explicitCommand || DEFAULT_COMMAND;
const bridge = new StdioMcpBridge(
  command,
  [...(explicitCommand ? [] : DEFAULT_COMMAND_ARGS), ...parseChildArgs()],
);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,accept',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('event: endpoint\n');
    res.write('data: /messages\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => clearInterval(keepAlive));
    return;
  }

  if (req.method === 'POST' && ['/message', '/messages', '/mcp'].includes(req.url || '')) {
    try {
      const raw = await readBody(req);
      const message = JSON.parse(raw || '{}');
      const reply = await bridge.request(message);
      if (reply === null) {
        res.writeHead(202, { 'access-control-allow-origin': '*' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(safeJson(reply));
    } catch (err) {
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(safeJson({
        jsonrpc: '2.0',
        error: { code: -32000, message: err?.message || String(err) },
      }));
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(port, host, () => {
  bridge.start();
  console.log(`[chrome-mcp-sse] listening on http://${host}:${port}/sse`);
});

process.on('SIGINT', () => {
  bridge.stop();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  bridge.stop();
  server.close(() => process.exit(0));
});
