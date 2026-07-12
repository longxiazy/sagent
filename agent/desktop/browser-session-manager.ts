import { closeBrowserSession, createBrowserSession } from '../tools/browser/webview-session.ts';

export function createSharedBrowserSessionManager() {
  let sharedBrowserSession: any = null;
  let sharedBrowserHeadless: boolean | null = null;

  async function getSharedBrowserSession(headless: boolean, onEvent?: (payload: any) => void) {
    if (sharedBrowserSession && sharedBrowserHeadless === headless) {
      return sharedBrowserSession;
    }
    if (sharedBrowserSession) {
      await closeBrowserSession(sharedBrowserSession);
      sharedBrowserSession = null;
    }
    sharedBrowserSession = createBrowserSession();
    sharedBrowserHeadless = headless;
    onEvent?.({
      type: 'status',
      status: 'browser_ready',
      message: 'Bun.WebView 浏览器已启动',
    });
    return sharedBrowserSession;
  }

  async function ensureBrowserSession(state: any, onEvent?: (payload: any) => void) {
    if (state.browserSession) {
      return state.browserSession;
    }
    const session = await getSharedBrowserSession(state.headless, onEvent);
    try {
      await Promise.resolve(session.view.navigate('about:blank'));
    } catch {
      await closeBrowserSession(session);
      if (session === sharedBrowserSession) {
        sharedBrowserSession = null;
        sharedBrowserHeadless = null;
      }
      throw new Error('WebView 初始化失败');
    }
    state.browserSession = session;
    return session;
  }

  async function resetBrowserSession(state?: any) {
    const stateSession = state?.browserSession || null;
    const session = stateSession || sharedBrowserSession;
    if (state) state.browserSession = null;
    if (session && session === sharedBrowserSession) {
      sharedBrowserSession = null;
      sharedBrowserHeadless = null;
    }
    if (session) await closeBrowserSession(session);
  }

  async function cleanupBrowserSession(state?: any) {
    const session = state?.browserSession || sharedBrowserSession;
    if (!session?.view) return;
    try {
      await Promise.resolve(session.view.navigate('about:blank'));
    } catch {
      await resetBrowserSession(state);
    }
  }

  async function withBrowserSessionRecovery(
    state: any,
    onEvent: ((payload: any) => void) | undefined,
    operation: (session: any) => Promise<any>,
  ) {
    let session = await ensureBrowserSession(state, onEvent);
    try {
      return await operation(session);
    } catch (err: any) {
      if (!/view is closed|invalid state.*webview/i.test(String(err?.message || err))) {
        throw err;
      }
      await resetBrowserSession(state);
      session = await ensureBrowserSession(state, onEvent);
      return operation(session);
    }
  }

  return {
    getSharedBrowserSession,
    ensureBrowserSession,
    resetBrowserSession,
    cleanupBrowserSession,
    withBrowserSessionRecovery,
  };
}
