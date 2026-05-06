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
    await session.view.navigate('about:blank').catch(() => {});
    state.browserSession = session;
    return session;
  }

  return {
    getSharedBrowserSession,
    ensureBrowserSession,
  };
}
