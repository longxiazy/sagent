import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

type PendingCommand = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
};

export class EdgeCdpWebView {
  // 该适配器刻意保持只读：只实现导航、页面求值和截图，不提供 CDP 输入事件。
  url = 'about:blank';
  title = '';
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private nextCommandId = 1;
  private pending = new Map<number, PendingCommand>();
  private closed = false;
  private profileDir: string | null = null;
  private ready: Promise<void>;

  constructor(private options: { width?: number; height?: number } = {}) {
    this.ready = this.start();
  }

  private async start() {
    const candidates = [
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean) as string[];
    const edgePath = candidates.find(candidate => existsSync(candidate));
    if (!edgePath) {
      throw new Error('未找到 Microsoft Edge。Windows 内置浏览器需要已安装 Edge。');
    }

    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selectedPort = typeof address === 'object' && address ? address.port : 0;
        server.close(error => error ? reject(error) : resolve(selectedPort));
      });
    });
    if (this.closed) throw new Error('Invalid state: WebView is closed');

    this.profileDir = mkdtempSync(path.join(os.tmpdir(), 'sagent-edge-'));
    this.child = spawn(edgePath, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${this.options.width || 1440},${this.options.height || 960}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--disable-features=msEdgeFirstRunExperience',
      'about:blank',
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });

    let target: any = null;
    let lastError: any = null;
    for (let attempt = 0; attempt < 100 && !this.closed; attempt += 1) {
      // Edge 在 Windows 上可能由当前进程转交给同一安装目录下的新浏览器进程，
      // 此时启动器会正常退出（exitCode 0），调试端口仍会由新进程继续提供。
      if (this.child.exitCode !== null && this.child.exitCode !== 0) {
        throw new Error(`Microsoft Edge 启动失败，退出码: ${this.child.exitCode}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (response.ok) {
          const targets: any[] = await response.json();
          target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
          if (target) break;
        }
      } catch (err) {
        lastError = err;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!target) {
      throw new Error(`无法连接 Microsoft Edge 调试端口${lastError ? `: ${String(lastError.message || lastError)}` : ''}`);
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      this.socket = socket;
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Microsoft Edge CDP WebSocket 连接失败')), { once: true });
      socket.addEventListener('message', event => {
        let message: any;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message.id) return;
        const command = this.pending.get(message.id);
        if (!command) return;
        this.pending.delete(message.id);
        if (message.error) {
          command.reject(new Error(message.error.message || 'Edge CDP 命令失败'));
        } else {
          command.resolve(message.result);
        }
      });
      socket.addEventListener('close', () => {
        const error = new Error('Invalid state: WebView is closed');
        for (const command of this.pending.values()) command.reject(error);
        this.pending.clear();
      });
    });

    await this.command('Page.enable');
    await this.command('Runtime.enable');
  }

  private async command(method: string, params: Record<string, any> = {}) {
    if (this.closed) throw new Error('Invalid state: WebView is closed');
    if (method !== 'Page.enable' && method !== 'Runtime.enable') await this.ready;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Invalid state: WebView CDP connection is closed');
    }
    const id = this.nextCommandId++;
    const result = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async navigate(url: string) {
    await this.ready;
    const result = await this.command('Page.navigate', { url });
    if (result.errorText) throw new Error(`navigation failed: ${result.errorText}`);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const state = await this.evaluate('document.readyState');
      if (state === 'complete' || state === 'interactive') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const page = await this.evaluate('({ url: window.location.href, title: document.title })');
    this.url = page?.url || url;
    this.title = page?.title || '';
  }

  async evaluate(script: string) {
    const response = await this.command('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || '页面脚本执行失败';
      throw new Error(detail);
    }
    return response.result?.value;
  }

  async screenshot(options: { format?: 'png' | 'jpeg'; quality?: number; encoding?: string } = {}) {
    const format = options.format === 'jpeg' ? 'jpeg' : 'png';
    const params: Record<string, any> = {
      format,
      fromSurface: true,
      captureBeyondViewport: false,
    };
    if (format === 'jpeg' && Number.isFinite(options.quality)) {
      params.quality = Math.max(0, Math.min(100, Number(options.quality)));
    }
    const result = await this.command('Page.captureScreenshot', params);
    if (!result?.data) throw new Error('Microsoft Edge 截图失败');
    return Buffer.from(result.data, 'base64');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.socket?.readyState === WebSocket.OPEN) {
        const id = this.nextCommandId++;
        const acknowledged = new Promise<void>((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
        });
        this.socket.send(JSON.stringify({ id, method: 'Browser.close', params: {} }));
        await Promise.race([
          acknowledged.catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
      }
    } catch {}
    try { this.socket?.close(); } catch {}
    try { this.child?.kill(); } catch {}
    if (this.profileDir) {
      const tempRoot = path.resolve(os.tmpdir());
      const resolvedProfile = path.resolve(this.profileDir);
      if (resolvedProfile.startsWith(`${tempRoot}${path.sep}`) && path.basename(resolvedProfile).startsWith('sagent-edge-')) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            rmSync(resolvedProfile, { recursive: true, force: true });
            break;
          } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
    }
  }
}
