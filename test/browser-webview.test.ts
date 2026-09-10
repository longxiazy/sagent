import { describe, it, expect, afterEach } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureBrowserPreview,
  closeBrowserSession,
  createBrowserSession,
  initWebViewDataStore,
  resetWebViewFactoryForTests,
  setWebViewFactoryForTests,
} from '../agent/tools/browser/webview-session.ts';
import { buildEdgeLaunchArgs } from '../agent/tools/browser/edge-cdp-webview.ts';
import { captureBrowserObservation, summarizeBrowserObservation } from '../agent/tools/browser/observe.ts';
import { executeBrowserAction } from '../agent/tools/browser/execute.ts';
import { createSharedBrowserSessionManager } from '../agent/desktop/browser-session-manager.ts';
import { runAgentRuntime } from '../agent/core/runtime.ts';

class FakeWebView {
  options: any;
  url: string;
  title: string;
  calls: any[];
  closed: boolean;

  constructor(options = {}) {
    this.options = options;
    this.url = 'about:blank';
    this.title = '';
    this.calls = [];
    this.closed = false;
  }

  async navigate(url) {
    this.calls.push(['navigate', url]);
    if (this.closed) throw new Error('Invalid state: WebView.navigate: view is closed');
    this.url = url;
  }

  async evaluate(script): Promise<any> {
    this.calls.push(['evaluate', script]);
    if (this.closed) throw new Error('Invalid state: WebView.evaluate: view is closed');
    if (script.includes('elements: []')) {
      return {
        title: 'Example',
        url: 'https://example.com',
        bodyText: 'hello '.repeat(100),
        elements: [],
      };
    }
    if (script.includes('document.title')) {
      return {
        title: 'Example',
        url: this.url,
        body: '页面正文',
      };
    }
    if (script.includes('tagName.toLowerCase')) {
      return { tagName: 'input', isEditable: false };
    }
    if (script.includes('document.body?.innerText')) {
      return '页面正文';
    }
    return null;
  }

  async click(selector, options) {
    this.calls.push(['click', selector, options]);
  }

  async type(selector, text) {
    this.calls.push(['type', selector, text]);
  }

  async press(key) {
    this.calls.push(['press', key]);
  }

  async screenshot() {
    this.calls.push(['screenshot']);
    return Buffer.from('fake-jpeg');
  }

  async close() {
    this.closed = true;
    this.calls.push(['close']);
  }
}

function deferred<T = void>() {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

class NotFoundWebView extends FakeWebView {
  async evaluate(script): Promise<any> {
    this.calls.push(['evaluate', script]);
    if (script.includes('document.title')) {
      return {
        title: '页面没有找到',
        url: 'https://example.com/missing',
        body: '页面没有找到 5秒钟之后将会带您进入首页!',
      };
    }
    if (script.includes('document.body?.innerText')) {
      return '页面没有找到 5秒钟之后将会带您进入首页!';
    }
    return super.evaluate(script);
  }
}

afterEach(async () => {
  await closeBrowserSession();
  resetWebViewFactoryForTests();
});

describe('Bun.WebView browser session adapter', () => {
  it('creates and closes a WebView-backed browser session', async () => {
    let created;
    setWebViewFactoryForTests(options => {
      created = new FakeWebView(options);
      return created;
    });

    const session = createBrowserSession({ width: 800, height: 600 });

    expect(session.view).toBe(created);
    expect(session.page).toBe(created);
    expect(created.options).toEqual({ width: 800, height: 600 });

    await closeBrowserSession(session);
    expect(created.closed).toBe(true);
  });

  it('closes a native view only once when cancellation and cleanup overlap', async () => {
    const view = new FakeWebView();
    const closing = deferred();
    view.close = async () => {
      view.calls.push(['close']);
      view.closed = true;
      await closing.promise;
    };
    setWebViewFactoryForTests(() => view);
    const session = createBrowserSession();

    const first = closeBrowserSession(session);
    const second = closeBrowserSession(view);
    expect(view.closed).toBe(true);
    expect(view.calls.filter(call => call[0] === 'close')).toHaveLength(1);
    closing.resolve();
    await Promise.all([first, second, closeBrowserSession(session)]);
    expect(view.calls.filter(call => call[0] === 'close')).toHaveLength(1);
  });

  it('uses a disposable data store for private browser sessions and removes it on close', async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), 'sagent-private-browser-test-'));
    let created;
    setWebViewFactoryForTests(options => {
      created = new FakeWebView(options);
      return created;
    });
    initWebViewDataStore(memoryDir);

    try {
      const session = createBrowserSession({ privateMode: true });
      const profileDir = created.options.dataStore.directory;

      expect(session.privateMode).toBe(true);
      expect(created.options.privateMode).toBe(true);
      expect(profileDir).toMatch(/sagent-private-browser-/);
      await expect(access(profileDir)).resolves.toBeUndefined();

      await closeBrowserSession(session);
      await expect(access(profileDir)).rejects.toThrow();
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it('keeps normal and private sessions separate and closes private sessions after a run', async () => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      created.push(view);
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const normalState: any = { headless: true, privateMode: false, browserSession: null };
    const privateState: any = { headless: true, privateMode: true, browserSession: null };

    await manager.ensureBrowserSession(normalState);
    await manager.ensureBrowserSession(privateState);

    expect(created).toHaveLength(2);
    expect(created[0].closed).toBe(true);
    expect(privateState.browserSession.privateMode).toBe(true);

    await manager.cleanupBrowserSession(privateState);
    expect(created[1].closed).toBe(true);
    expect(privateState.browserSession).toBeNull();
  });

  it('adds Edge InPrivate only when private mode is enabled', () => {
    const base = { port: 1234, profileDir: '/tmp/sagent-edge-test' };
    const normalArgs = buildEdgeLaunchArgs(base);
    const privateArgs = buildEdgeLaunchArgs({ ...base, privateMode: true });

    expect(normalArgs).not.toContain('--inprivate');
    expect(privateArgs).toContain('--inprivate');
  });

  it('stores a browser preview and publishes a local screenshot URL', async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), 'sagent-browser-preview-'));
    initWebViewDataStore(memoryDir);
    const view = new FakeWebView();
    view.url = 'https://example.com/report';

    try {
      const preview = await captureBrowserPreview(view, { runId: 'run_preview' });

      expect(preview).toMatchObject({
        title: 'Example',
        url: 'https://example.com/report',
      });
      expect(preview?.screenshotUrl).toMatch(/^\/screenshots\/run_preview\/browser-preview-\d+\.jpg$/);
      const relativePath = preview!.screenshotUrl.replace('/screenshots/', '');
      await expect(readFile(path.join(memoryDir, 'screenshots', relativePath), 'utf8')).resolves.toBe('fake-jpeg');
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it('does not call screenshot or create files in private mode', async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), 'sagent-browser-preview-private-'));
    initWebViewDataStore(memoryDir);
    const view = new FakeWebView();
    view.url = 'https://example.com/private';

    try {
      await expect(captureBrowserPreview(view, { runId: 'run_private_preview', privateMode: true }))
        .resolves.toBeNull();
      expect(view.calls.some(call => call[0] === 'screenshot')).toBe(false);
      await expect(access(path.join(memoryDir, 'screenshots', 'run_private_preview'))).rejects.toThrow();
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('throws a clear runtime error when Bun.WebView is unavailable', () => {
    resetWebViewFactoryForTests();
    const originalBun = globalThis.Bun;

    try {
      delete globalThis.Bun;
      expect(() => createBrowserSession()).toThrow(/Bun\.WebView 不可用/);
    } finally {
      if (originalBun !== undefined) {
        globalThis.Bun = originalBun;
      }
    }
  });
});

describe('Bun.WebView run lifecycle', () => {
  it('closes normal runs, preserves their profile, and creates a fresh view for the next run', async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), 'sagent-browser-lifecycle-'));
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      created.push(view);
      return view;
    });
    initWebViewDataStore(memoryDir);
    const manager = createSharedBrowserSessionManager();
    const firstState: any = { browserSession: null };
    const nextState: any = { browserSession: null };

    try {
      const first = await manager.ensureBrowserSession(firstState);
      expect(await manager.ensureBrowserSession(firstState)).toBe(first);
      const profileDir = first.view.options.dataStore.directory;
      const marker = path.join(profileDir, 'login-state-fixture');
      await writeFile(marker, 'keep-login-data');
      await first.view.navigate('https://example.com/video');

      await manager.cleanupBrowserSession(firstState);
      expect(first.view.closed).toBe(true);
      expect(firstState.browserSession).toBeNull();
      await expect(manager.ensureBrowserSession(firstState)).rejects.toThrow('任务已结束');

      const next = await manager.ensureBrowserSession(nextState);
      expect(created).toHaveLength(2);
      expect(next.view).not.toBe(first.view);
      expect(next.view.options.dataStore.directory).toBe(profileDir);
      await expect(readFile(marker, 'utf8')).resolves.toBe('keep-login-data');
      // 重复收尾不能落到共享实例上，把下一任务刚创建的页面关掉。
      await manager.cleanupBrowserSession(firstState);
      await manager.cleanupBrowserSession({ browserSession: null });
      expect(next.view.closed).toBe(false);
    } finally {
      await manager.cleanupBrowserSession(firstState);
      await manager.cleanupBrowserSession(nextState);
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  it('closes media immediately while the runtime is waiting for its next model decision', async () => {
    const view = new FakeWebView();
    setWebViewFactoryForTests(() => view);
    const manager = createSharedBrowserSessionManager();
    const controller = new AbortController();
    const state: any = { browserSession: null, cancelSignal: controller.signal };
    await manager.ensureBrowserSession(state);
    const deciding = deferred();
    const resumeDecision = deferred();
    const run = runAgentRuntime({
      task: 'read the page',
      cancelSignal: controller.signal,
      initialize: async () => state,
      observe: async () => ({}),
      decide: async () => {
        deciding.resolve();
        await resumeDecision.promise;
        return { rationale: 'done', action: { tool: 'core', type: 'finish', answer: 'completed' } };
      },
      execute: async () => 'completed',
      cleanup: manager.cleanupBrowserSession,
    });
    const cancelled = expect(run).rejects.toThrow('Agent 已取消');

    await deciding.promise;
    controller.abort();
    // 不释放模型 Promise，也应当已经同步调用 close，不能等 runtime finally 才停播。
    expect(view.closed).toBe(true);
    resumeDecision.resolve();
    await cancelled;
    expect(state.browserSession).toBeNull();
    expect(view.calls.filter(call => call[0] === 'close')).toHaveLength(1);
  });

  it('closes private sessions on cancellation and removes their disposable profile', async () => {
    const view = new FakeWebView();
    setWebViewFactoryForTests(() => view);
    const manager = createSharedBrowserSessionManager();
    const controller = new AbortController();
    const state: any = { privateMode: true, browserSession: null, cancelSignal: controller.signal };
    const session = await manager.ensureBrowserSession(state);
    const profileDir = session.privateProfileDir;
    await access(profileDir);

    controller.abort();
    expect(view.closed).toBe(true);
    await manager.cleanupBrowserSession(state);
    await expect(access(profileDir)).rejects.toThrow();
    expect(view.calls.filter(call => call[0] === 'close')).toHaveLength(1);
  });

  it.each(['rejects', 'hangs'] as const)('cancels a navigation whose native promise %s after close without rebuilding', async closeBehavior => {
    const created: FakeWebView[] = [];
    const navigating = deferred();
    const navigation = deferred();
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      if (created.length === 0) {
        const navigate = view.navigate.bind(view);
        const close = view.close.bind(view);
        view.navigate = async url => {
          await navigate(url);
          if (url === 'about:blank') return;
          navigating.resolve();
          await navigation.promise;
        };
        view.close = async () => {
          await close();
          if (closeBehavior === 'rejects') navigation.reject(new Error('Invalid state: WebView.navigate: view is closed'));
        };
      }
      created.push(view);
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const controller = new AbortController();
    const state: any = { browserSession: null, cancelSignal: controller.signal };
    const events: any[] = [];
    const operation = manager.withBrowserSessionRecovery(state, event => events.push(event), (session, recoveryAttempt) => (
      executeBrowserAction(session.view, { type: 'navigate', url: 'https://example.com/video' }, {
        signal: controller.signal,
        recoveryAttempt,
      })
    ));
    const cancelled = expect(operation).rejects.toThrow('Agent 已取消');

    await navigating.promise;
    controller.abort();
    expect(created[0].closed).toBe(true);
    await cancelled;
    await manager.cleanupBrowserSession(state);
    expect(created).toHaveLength(1);
    expect(created[0].calls.filter(call => call[0] === 'close')).toHaveLength(1);
    expect(events.some(event => event.status === 'recovering')).toBe(false);

    // 旧原生 Promise 不落定也不能占住操作队列；新任务可用，旧任务迟到的结果不能影响它。
    const nextState: any = { browserSession: null };
    const next = await manager.ensureBrowserSession(nextState);
    navigation.resolve();
    await manager.serializeBrowserOperation(async () => {});
    expect(next.view.closed).toBe(false);
    await manager.cleanupBrowserSession(nextState);
  });

  it('cancels during initial health navigation and ignores its late result', async () => {
    const view = new FakeWebView();
    const navigating = deferred();
    const navigation = deferred();
    view.navigate = async url => {
      view.calls.push(['navigate', url]);
      navigating.resolve();
      await navigation.promise;
    };
    setWebViewFactoryForTests(() => view);
    const manager = createSharedBrowserSessionManager();
    const controller = new AbortController();
    const state: any = { browserSession: null, cancelSignal: controller.signal };
    const events: any[] = [];
    const initializing = manager.ensureBrowserSession(state, event => events.push(event));
    const cancelled = expect(initializing).rejects.toThrow('Agent 已取消');

    await navigating.promise;
    controller.abort();
    expect(view.closed).toBe(true);
    await cancelled;
    navigation.resolve();
    await manager.cleanupBrowserSession(state);
    await manager.serializeBrowserOperation(async () => {});
    expect(view.calls.some(call => call[0] === 'evaluate')).toBe(false);
    expect(events.some(event => event.status === 'ready' || event.status === 'browser_ready')).toBe(false);
    expect(state.browserSession).toBeNull();
  });

  it.each(['recovering', 'starting'] as const)('does not retry when cancelled during recovery at %s', async cancelAt => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      created.push(view);
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const controller = new AbortController();
    const state: any = { browserSession: null, cancelSignal: controller.signal };
    let calls = 0;
    const result = manager.withBrowserSessionRecovery(state, event => {
      if (event.status === cancelAt && (cancelAt !== 'starting' || event.generation === 2)) controller.abort();
    }, async () => {
      calls += 1;
      throw new Error('Invalid state: WebView.navigate: view is closed');
    });

    await expect(result).rejects.toThrow('Agent 已取消');
    await manager.cleanupBrowserSession(state);
    expect(calls).toBe(1);
    expect(created).toHaveLength(cancelAt === 'recovering' ? 1 : 2);
    expect(created.every(view => view.closed)).toBe(true);
    expect(state.browserRecoveryFailures || 0).toBe(0);
  });

  it('never creates a view for an already cancelled or queued cancelled operation', async () => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      created.push(view);
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const blocking = deferred();
    const blocked = manager.serializeBrowserOperation(() => blocking.promise);
    const controller = new AbortController();
    const state: any = { browserSession: null, cancelSignal: controller.signal };
    const initializing = manager.ensureBrowserSession(state);
    controller.abort();

    await expect(initializing).rejects.toThrow('Agent 已取消');
    await expect(manager.ensureBrowserSession(state)).rejects.toThrow('Agent 已取消');
    await expect(executeBrowserAction(null, { type: 'navigate', url: 'https://example.com' }, { signal: controller.signal })).rejects.toThrow();
    expect(created).toHaveLength(0);
    blocking.resolve();
    await blocked;
    await manager.serializeBrowserOperation(async () => {});
    expect(created).toHaveLength(0);
  });

  it('blocks queued browser work after normal cleanup', async () => {
    let creations = 0;
    setWebViewFactoryForTests(options => { creations += 1; return new FakeWebView(options); });
    const manager = createSharedBrowserSessionManager();
    const blocking = deferred();
    const blocked = manager.serializeBrowserOperation(() => blocking.promise);
    const state: any = { browserSession: null };
    const initializing = manager.ensureBrowserSession(state);
    const ended = expect(initializing).rejects.toThrow('任务已结束');

    await manager.cleanupBrowserSession(state);
    blocking.resolve();
    await blocked;
    await ended;
    expect(creations).toBe(0);
  });

  it('does not let old task cancellation or cleanup close a replacement task session', async () => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      created.push(view);
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const oldController = new AbortController();
    const firstState: any = { browserSession: null, cancelSignal: oldController.signal };
    const nextState: any = { browserSession: null };
    await manager.ensureBrowserSession(firstState);
    const next = await manager.ensureBrowserSession(nextState);

    expect(created[0].closed).toBe(true);
    oldController.abort();
    await manager.cleanupBrowserSession(firstState);
    expect(next.view.closed).toBe(false);
    expect(nextState.browserSession).toBe(next);
    await manager.cleanupBrowserSession(nextState);
  });

  it('closes the browser when the runtime fails', async () => {
    const view = new FakeWebView();
    setWebViewFactoryForTests(() => view);
    const manager = createSharedBrowserSessionManager();
    const state: any = { browserSession: null };
    await manager.ensureBrowserSession(state);

    await expect(runAgentRuntime({
      task: 'read a page',
      initialize: async () => state,
      observe: async () => ({}),
      decide: async () => { throw new Error('model failed'); },
      execute: async () => '',
      cleanup: manager.cleanupBrowserSession,
    })).rejects.toThrow('model failed');
    expect(view.closed).toBe(true);
    expect(state.browserSession).toBeNull();
  });
});

describe('Bun.WebView browser observation', () => {
  it('captures read-only page metadata without exposing interactive elements', async () => {
    const view = new FakeWebView();
    const observation = await captureBrowserObservation(view);
    const summary = summarizeBrowserObservation(observation);

    expect(observation.title).toBe('Example');
    expect(observation.elements).toEqual([]);
    expect(summary.elements).toEqual([]);
    expect(summary.text.length).toBeLessThanOrEqual(323);
  });
});

describe('Bun.WebView browser actions', () => {
  it('preserves the original WebView initialization error', async () => {
    const originalError = new Error('Chrome WebSocket closed (code 1006)');
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      view.navigate = async () => {
        throw originalError;
      };
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const state = { headless: true, browserSession: null };
    const events: any[] = [];

    try {
      await manager.ensureBrowserSession(state, event => events.push(event));
      throw new Error('预期 WebView 初始化失败');
    } catch (err: any) {
      expect(err.message).toBe('WebView 初始化失败: Chrome WebSocket closed (code 1006)');
      expect(err.cause).toBe(originalError);
    }
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'browser_session',
        status: 'degraded',
        reason: 'initialization_failed',
        error: 'Chrome WebSocket closed (code 1006)',
      }),
    ]));
  });

  it('executes read-only actions and rejects legacy interaction actions', async () => {
    const view = new FakeWebView();

    await expect(executeBrowserAction(view, { type: 'navigate', url: 'https://example.com' }))
      .resolves.toContain('已打开 https://example.com');
    await expect(executeBrowserAction(view, { type: 'click', elementId: '2' }))
      .resolves.toMatchObject({ resultStatus: 'failed', resultError: '内置浏览器不支持交互操作' });
    await expect(executeBrowserAction(view, { type: 'type', elementId: '3', text: 'hello', submit: true }))
      .resolves.toMatchObject({ resultStatus: 'failed', resultError: '内置浏览器不支持交互操作' });
    await expect(executeBrowserAction(view, { type: 'scroll', direction: 'down', amount: 2 }))
      .resolves.toContain('已向下滚动 2 步');
    await expect(executeBrowserAction(view, { type: 'get_page_content' }))
      .resolves.toBe('页面正文');

    expect(view.calls).toContainEqual(['navigate', 'https://example.com']);
    expect(view.calls.some(call => call[0] === 'click')).toBe(false);
    expect(view.calls.some(call => call[0] === 'type')).toBe(false);
    expect(view.calls.some(call => call[0] === 'press')).toBe(false);
  });

  it('marks unavailable http_fetch pages as structured failures', async () => {
    const view = new NotFoundWebView();

    const result = await executeBrowserAction(view, { type: 'http_fetch', url: 'https://example.com/missing' });

    expect(result).toMatchObject({
      resultStatus: 'failed',
      resultError: '页面不可用',
    });
    expect(result.result).toContain('页面不可用');
  });

  it('recreates a closed WebView and retries http_fetch once', async () => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      if (created.length === 0) {
        const navigate = view.navigate.bind(view);
        view.navigate = async url => {
          if (url !== 'about:blank') {
            view.closed = true;
            throw new Error('Invalid state: WebView.navigate: view is closed');
          }
          return navigate(url);
        };
      }
      created.push(view);
      return view;
    });

    const manager = createSharedBrowserSessionManager();
    const state = { headless: true, browserSession: null };
    const events: any[] = [];
    const result = await manager.withBrowserSessionRecovery(state, event => events.push(event), session => (
      executeBrowserAction(session.view, {
        type: 'http_fetch',
        url: 'https://example.com/report',
        extractLinks: false,
      })
    ), { step: 2, url: 'https://example.com/report' });

    expect(result).toContain('页面正文');
    expect(created).toHaveLength(2);
    expect(state.browserSession?.view).toBe(created[1]);
    expect(state.browserSession?.generation).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'browser_session', status: 'recovering', reason: 'view_closed', step: 2, generation: 1 }),
      expect.objectContaining({ type: 'browser_session', status: 'ready', recreated: true, sessionId: 2, generation: 2 }),
    ]));
  });

  it('serializes browser operations while keeping task sessions separate', async () => {
    setWebViewFactoryForTests(options => new FakeWebView(options));
    const manager = createSharedBrowserSessionManager();
    const firstState: any = { headless: true, browserSession: null };
    const secondState: any = { headless: true, browserSession: null };
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const run = (label: string, state: any) => manager.withBrowserSessionRecovery(state, undefined, async session => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${label}:start:${session.generation}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push(`${label}:end:${session.generation}`);
      active -= 1;
      return label;
    });

    await expect(Promise.all([run('first', firstState), run('second', secondState)]))
      .resolves.toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['first:start:1', 'first:end:1', 'second:start:2', 'second:end:2']);
    await manager.cleanupBrowserSession(firstState);
    await manager.cleanupBrowserSession(secondState);
  });

  it('bounds a hanging close and clears the session reference', async () => {
    const view = new FakeWebView();
    view.close = async () => new Promise(() => {});
    setWebViewFactoryForTests(() => view);
    const manager = createSharedBrowserSessionManager({ closeTimeoutMs: 10 });
    const state: any = { headless: true, browserSession: null };
    const session = await manager.ensureBrowserSession(state);

    const startedAt = Date.now();
    await manager.resetBrowserSession(state);

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(state.browserSession).toBeNull();
    expect(session.lifecycle).toBe('closed');
  });

  it('uses a longer navigation timeout after recreating an invalid session', async () => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      const baseNavigate = view.navigate.bind(view);
      view.navigate = async url => {
        if (url === 'about:blank') return baseNavigate(url);
        if (created.length === 0) {
          await new Promise((_, reject) => {
            view.close = async () => {
              view.closed = true;
              reject(new Error('Invalid state: WebView.navigate: view is closed'));
            };
          });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
        return baseNavigate(url);
      };
      created.push(view);
      return view;
    });

    const manager = createSharedBrowserSessionManager();
    const state: any = { headless: true, browserSession: null };
    const result = await manager.withBrowserSessionRecovery(state, undefined, (session, recoveryAttempt) => (
      executeBrowserAction(session.view, {
        type: 'http_fetch',
        url: 'https://example.com/slow',
        timeoutMs: 20,
      }, { recoveryAttempt })
    ));

    expect(result).toBe('页面正文');
    expect(created).toHaveLength(2);
    expect(state.browserRecoveryFailures).toBe(0);
  });

  it('opens a per-run circuit after two failed session recoveries', async () => {
    const created: FakeWebView[] = [];
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      const baseNavigate = view.navigate.bind(view);
      view.navigate = async url => {
        if (url === 'about:blank') return baseNavigate(url);
        await new Promise((_, reject) => {
          view.close = async () => {
            view.closed = true;
            reject(new Error('Invalid state: WebView.navigate: view is closed'));
          };
        });
      };
      created.push(view);
      return view;
    });

    const manager = createSharedBrowserSessionManager();
    const state: any = { headless: true, browserSession: null };
    const events: any[] = [];
    const operation = (session, recoveryAttempt) => executeBrowserAction(session.view, {
      type: 'http_fetch',
      url: 'https://example.com/hangs',
      timeoutMs: 5,
    }, { recoveryAttempt });

    await expect(manager.withBrowserSessionRecovery(state, event => events.push(event), operation)).rejects.toThrow('恢复会话后仍超时');
    const second = await manager.withBrowserSessionRecovery(state, event => events.push(event), operation);
    const third = await manager.withBrowserSessionRecovery(state, event => events.push(event), operation);

    expect(second).toMatchObject({ resultStatus: 'failed', resultError: '内置浏览器会话熔断' });
    expect(third).toMatchObject({ resultStatus: 'failed', resultError: '内置浏览器会话熔断' });
    expect(state.browserSession).toBeNull();
    expect(state.browserCircuitOpen).toBe(true);
    expect(created).toHaveLength(4);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'browser_session', status: 'degraded', circuitOpen: true, recoveryFailures: 2 }),
      expect.objectContaining({ type: 'browser_session', status: 'degraded', reason: 'circuit_open' }),
    ]));
  });

  it('keeps a core.finish result when WebView cleanup throws synchronously', async () => {
    let closeCalls = 0;
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      view.close = () => {
        closeCalls += 1;
        throw new Error('Invalid state: WebView.close: view is closed');
      };
      return view;
    });

    const manager = createSharedBrowserSessionManager();
    const state: any = { headless: true, browserSession: null };
    await manager.ensureBrowserSession(state);

    const result = await runAgentRuntime({
      task: 'return a completed result',
      maxSteps: 1,
      initialize: async () => state,
      observe: async () => ({}),
      decide: async () => ({
        rationale: 'done',
        action: { tool: 'core', type: 'finish', answer: 'completed' },
      }),
      execute: async () => 'completed',
      cleanup: manager.cleanupBrowserSession,
    });

    expect(result.answer).toBe('completed');
    expect(closeCalls).toBe(1);
    expect(state.browserSession).toBeNull();
  });
});
