import { describe, it, expect, afterEach } from 'vitest';
import {
  closeBrowserSession,
  createBrowserSession,
  resetWebViewFactoryForTests,
  setWebViewFactoryForTests,
} from '../agent/tools/browser/webview-session.ts';
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
    this.url = url;
  }

  async evaluate(script): Promise<any> {
    this.calls.push(['evaluate', script]);
    if (script.includes('querySelectorAll')) {
      return {
        title: 'Example',
        url: 'https://example.com',
        bodyText: 'hello '.repeat(100),
        elements: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), text: `Element ${index + 1}` })),
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

  async close() {
    this.closed = true;
    this.calls.push(['close']);
  }
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
  resetWebViewFactoryForTests();
  await closeBrowserSession();
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

describe('Bun.WebView browser observation', () => {
  it('captures page metadata and summarizes visible elements', async () => {
    const view = new FakeWebView();
    const observation = await captureBrowserObservation(view);
    const summary = summarizeBrowserObservation(observation);

    expect(observation.title).toBe('Example');
    expect(observation.elements).toHaveLength(10);
    expect(summary.elements).toHaveLength(8);
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

  it('executes navigation, click, typing, scroll, content, and search actions through WebView', async () => {
    const view = new FakeWebView();

    await expect(executeBrowserAction(view, { type: 'navigate', url: 'https://example.com' }))
      .resolves.toContain('已打开 https://example.com');
    await expect(executeBrowserAction(view, { type: 'click', elementId: '2' }))
      .resolves.toContain('已点击元素 2');
    await expect(executeBrowserAction(view, { type: 'type', elementId: '3', text: 'hello', submit: true }))
      .resolves.toContain('已在元素 3 输入内容');
    await expect(executeBrowserAction(view, { type: 'scroll', direction: 'down', amount: 2 }))
      .resolves.toContain('已向下滚动 2 步');
    await expect(executeBrowserAction(view, { type: 'get_page_content' }))
      .resolves.toBe('页面正文');

    expect(view.calls).toContainEqual(['navigate', 'https://example.com']);
    expect(view.calls).toContainEqual(['click', '[data-agent-node-id="2"]', { timeout: 10000 }]);
    expect(view.calls).toContainEqual(['type', '[data-agent-node-id="3"]', 'hello']);
    expect(view.calls).toContainEqual(['press', 'Enter']);
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

  it('serializes operations that share the same WebView', async () => {
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
    expect(order).toEqual(['first:start:1', 'first:end:1', 'second:start:1', 'second:end:1']);
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
    let blankNavigations = 0;
    setWebViewFactoryForTests(options => {
      const view = new FakeWebView(options);
      const navigate = view.navigate.bind(view);
      view.navigate = async url => {
        if (url === 'about:blank') {
          blankNavigations += 1;
          if (blankNavigations > 1) {
            throw new Error('Invalid state: WebView.navigate: view is closed');
          }
        }
        return navigate(url);
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
  });
});
