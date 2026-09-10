import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from '../agent/tools/browser/execute.ts';
import { createSharedBrowserSessionManager } from '../agent/desktop/browser-session-manager.ts';
import { resetWebViewFactoryForTests, setWebViewFactoryForTests } from '../agent/tools/browser/webview-session.ts';

// 本文件验证结果和错误传递，跳过固定页面等待；真实取消时序由 browser-webview.test.ts 覆盖。
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));

function createView() {
  return {
    navigate: vi.fn(async (_url: string) => {}),
    evaluate: vi.fn(async (script: string): Promise<any> => script.includes('document.title')
      ? { title: 'Previous page', url: 'https://example.com/previous', body: '旧页面正文' }
      : '旧页面正文'),
    close: vi.fn(async () => {}),
  };
}

afterEach(() => resetWebViewFactoryForTests());

describe('browser action failures', () => {
  it.each(['navigate', 'http_fetch'])('reports %s as failed when every navigation attempt stays pending', async type => {
    const view = createView();
    view.navigate.mockRejectedValue(new Error('WebView.navigate: navigation already pending'));

    const result = await executeBrowserAction(view, { type, url: 'https://example.com/new' });

    expect(result).toMatchObject({ resultStatus: 'failed' });
    expect(result.resultError).toContain('already pending');
    // 目标页面从未打开，不能继续读取旧页面并把它当成此次导航的结果。
    expect(view.evaluate).not.toHaveBeenCalled();
  });

  it('retries a temporarily pending navigation and still returns its content', async () => {
    const view = createView();
    view.navigate.mockRejectedValueOnce(new Error('WebView.navigate: navigation already pending'));

    await expect(executeBrowserAction(view, { type: 'http_fetch', url: 'https://example.com/report' }))
      .resolves.toBe('旧页面正文');
    expect(view.navigate).toHaveBeenCalledTimes(2);
  });

  it.each(['navigate', 'http_fetch'])('preserves invalid-session errors containing timeout/navigation in %s', async type => {
    const view = createView();
    const failure = Object.assign(new Error('WebView navigation timeout'), { code: 'BROWSER_SESSION_INVALID' });
    view.navigate.mockRejectedValue(failure);

    await expect(executeBrowserAction(view, { type, url: 'https://example.com/report' })).rejects.toBe(failure);
  });

  it.each(['navigate', 'http_fetch'])('propagates a closed view from the page check in %s', async type => {
    const view = createView();
    const failure = new Error('Invalid state: WebView.evaluate: view is closed');
    view.evaluate.mockRejectedValueOnce(failure);

    await expect(executeBrowserAction(view, { type, url: 'https://example.com/report' })).rejects.toBe(failure);
    expect(view.evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(['navigate', 'http_fetch'])('keeps the page check optional for ordinary script errors in %s', async type => {
    const view = createView();
    view.evaluate.mockRejectedValueOnce(new Error('page metadata script failed'));

    const result = await executeBrowserAction(view, { type, url: 'https://example.com/report' });

    expect(result).toBe(type === 'navigate' ? '已打开 https://example.com/report' : '旧页面正文');
  });

  it('lets the session manager rebuild a view after an invalid navigation error', async () => {
    const created: ReturnType<typeof createView>[] = [];
    setWebViewFactoryForTests(() => {
      const view = createView();
      if (created.length === 0) {
        view.navigate.mockImplementation(async url => {
          if (url !== 'about:blank') {
            throw Object.assign(new Error('WebView navigation timeout'), { code: 'BROWSER_SESSION_INVALID' });
          }
        });
      }
      created.push(view);
      return view;
    });
    const manager = createSharedBrowserSessionManager();
    const state: any = { browserSession: null };

    try {
      const result = await manager.withBrowserSessionRecovery(state, undefined, (session, recoveryAttempt) => (
        executeBrowserAction(session.view, { type: 'http_fetch', url: 'https://example.com/report' }, { recoveryAttempt })
      ));
      expect(result).toBe('旧页面正文');
      expect(created).toHaveLength(2);
      expect(created[0].close).toHaveBeenCalledTimes(1);
      expect(state.browserSession.view).toBe(created[1]);
    } finally {
      await manager.cleanupBrowserSession(state);
    }
  });
});
