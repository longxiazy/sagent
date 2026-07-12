import { closeBrowserSession, createBrowserSession } from '../tools/browser/webview-session.ts';

export function createSharedBrowserSessionManager() {
  let sharedBrowserSession: any = null;
  let sharedBrowserHeadless: boolean | null = null;
  let nextSessionId = 1;

  const emit = (onEvent: ((payload: any) => void) | undefined, status: string, session: any, extra: any = {}) => {
    onEvent?.({ type: 'browser_session', status, sessionId: session?.sessionId || null, timestamp: Date.now(), ...extra });
  };

  async function getSharedBrowserSession(headless: boolean, onEvent?: (payload: any) => void) {
    if (sharedBrowserSession && sharedBrowserHeadless === headless) {
      return sharedBrowserSession;
    }
    if (sharedBrowserSession) {
      await closeBrowserSession(sharedBrowserSession);
      sharedBrowserSession = null;
    }
    onEvent?.({ type: 'browser_session', status: 'starting', sessionId: nextSessionId, timestamp: Date.now() });
    sharedBrowserSession = { ...createBrowserSession(), sessionId: nextSessionId++ };
    sharedBrowserHeadless = headless;
    onEvent?.({
      type: 'status',
      status: 'browser_ready',
      message: 'Bun.WebView 浏览器已启动',
      sessionId: sharedBrowserSession.sessionId,
    });
    emit(onEvent, 'ready', sharedBrowserSession, { url: 'about:blank' });
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
      emit(onEvent, 'degraded', session, { reason: 'initialization_failed' });
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
    context: any = {},
  ) {
    let session = await ensureBrowserSession(state, onEvent);
    emit(onEvent, 'navigating', session, context);
    try {
      const result = await operation(session);
      emit(onEvent, 'ready', session, context);
      return result;
    } catch (err: any) {
      if (!/view is closed|invalid state.*webview/i.test(String(err?.message || err))) {
        emit(onEvent, 'degraded', session, { ...context, reason: String(err?.message || err).slice(0, 160) });
        throw err;
      }
      emit(onEvent, 'recovering', session, { ...context, reason: 'view_closed', retry: 1 });
      await resetBrowserSession(state);
      session = await ensureBrowserSession(state, onEvent);
      try {
        const result = await operation(session);
        emit(onEvent, 'ready', session, { ...context, recreated: true, retry: 1 });
        return result;
      } catch (retryErr: any) {
        emit(onEvent, 'degraded', session, { ...context, reason: String(retryErr?.message || retryErr).slice(0, 160), retry: 1 });
        throw retryErr;
      }
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
