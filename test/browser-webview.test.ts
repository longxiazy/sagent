import { describe, it, expect, afterEach } from 'vitest';
import {
  closeBrowserSession,
  createBrowserSession,
  resetWebViewFactoryForTests,
  setWebViewFactoryForTests,
} from '../agent/tools/browser/webview-session.ts';
import { captureBrowserObservation, summarizeBrowserObservation } from '../agent/tools/browser/observe.ts';
import { executeBrowserAction } from '../agent/tools/browser/execute.ts';

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

  async evaluate(script) {
    this.calls.push(['evaluate', script]);
    if (script.includes('querySelectorAll')) {
      return {
        title: 'Example',
        url: 'https://example.com',
        bodyText: 'hello '.repeat(100),
        elements: Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1), text: `Element ${index + 1}` })),
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

  it('throws a clear runtime error when Bun.WebView is unavailable', () => {
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
    await expect(executeBrowserAction(view, { type: 'google_search', query: 'sagent' }))
      .resolves.toContain('Google 搜索');

    expect(view.calls).toContainEqual(['navigate', 'https://example.com']);
    expect(view.calls).toContainEqual(['click', '[data-agent-node-id="2"]', { timeout: 10000 }]);
    expect(view.calls).toContainEqual(['type', '[data-agent-node-id="3"]', 'hello']);
    expect(view.calls).toContainEqual(['press', 'Enter']);
    expect(view.calls).toContainEqual(['navigate', 'https://www.google.com/search?q=sagent']);
  });
});
