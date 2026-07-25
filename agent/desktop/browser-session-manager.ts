/**
 * Shared built-in browser session manager.
 *
 * Sessions are matched by headless + privateMode, all operations pass through one
 * serial queue, and an invalid WebView is recreated once before a per-run circuit
 * breaker stops further built-in-browser calls. Normal sessions are reset to about:blank
 * for reuse; private sessions are closed so their temporary profile can be deleted.
 */

import { captureBrowserPreview, closeBrowserSession, createBrowserSession } from '../tools/browser/webview-session.ts';

type BrowserLifecycle = 'starting' | 'ready' | 'busy' | 'broken' | 'closing' | 'closed';

type ManagedBrowserSession = {
  view: any;
  page: any;
  privateMode?: boolean;
  privateProfileDir?: string | null;
  sessionId: number;
  generation: number;
  lifecycle: BrowserLifecycle;
  closePromise?: Promise<void> | null;
};

function staleSessionError() {
  const err: any = new Error('浏览器会话已被替换，忽略旧 WebView 操作结果');
  err.code = 'STALE_BROWSER_SESSION';
  return err;
}

export function createSharedBrowserSessionManager({ closeTimeoutMs = 3_000 } = {}) {
  const MAX_RECOVERY_FAILURES_PER_RUN = 2;
  let sharedBrowserSession: ManagedBrowserSession | null = null;
  let sharedBrowserHeadless: boolean | null = null;
  let sharedBrowserPrivateMode: boolean | null = null;
  let nextSessionId = 1;
  let nextGeneration = 1;
  let operationQueue: Promise<unknown> = Promise.resolve();

  const emit = (onEvent: ((payload: any) => void) | undefined, status: string, session: ManagedBrowserSession | null, extra: any = {}) => {
    onEvent?.({
      type: 'browser_session',
      status,
      sessionId: session?.sessionId || null,
      generation: session?.generation || null,
      lifecycle: session?.lifecycle || 'closed',
      privateMode: Boolean(session?.privateMode),
      timestamp: Date.now(),
      ...extra,
    });
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = operationQueue.then(operation, operation);
    operationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const isRecoverableSessionError = (err: any) => (
    err?.code === 'BROWSER_SESSION_INVALID'
    || err?.code === 'STALE_BROWSER_SESSION'
    || /view is closed|invalid state.*webview/i.test(String(err?.message || err))
  );

  const circuitOpenResult = () => ({
    result: '内置浏览器连续恢复失败，本次任务已暂停继续使用内置浏览器。请改用 web_search、Chrome MCP 或其他来源。',
    resultStatus: 'failed',
    resultError: '内置浏览器会话熔断',
  });

  function isCurrentSession(session: ManagedBrowserSession, generation = session.generation) {
    return session === sharedBrowserSession
      && session.generation === generation
      && session.lifecycle !== 'closing'
      && session.lifecycle !== 'closed';
  }

  function assertCurrentSession(session: ManagedBrowserSession, generation = session.generation) {
    if (!isCurrentSession(session, generation)) throw staleSessionError();
  }

  async function closeSessionBounded(session: ManagedBrowserSession | null) {
    if (!session || session.lifecycle === 'closed') return;
    if (session.closePromise) return session.closePromise;

    session.lifecycle = 'closing';
    const closeTask = Promise.resolve(closeBrowserSession(session)).catch(() => {});
    session.closePromise = Promise.race([
      closeTask,
      new Promise<void>(resolve => setTimeout(resolve, closeTimeoutMs)),
    ]).then(() => {
      session.lifecycle = 'closed';
    });
    await session.closePromise;
  }

  async function getSharedBrowserSessionInternal(headless: boolean, privateMode: boolean, onEvent?: (payload: any) => void) {
    // headless/privateMode 属于会话隔离条件；任一变化都不能复用旧 WebView。
    if (
      sharedBrowserSession
      && sharedBrowserHeadless === headless
      && sharedBrowserPrivateMode === privateMode
      && sharedBrowserSession.lifecycle !== 'broken'
      && sharedBrowserSession.lifecycle !== 'closing'
      && sharedBrowserSession.lifecycle !== 'closed'
    ) {
      return sharedBrowserSession;
    }
    if (sharedBrowserSession) {
      const previous = sharedBrowserSession;
      sharedBrowserSession = null;
      sharedBrowserHeadless = null;
      sharedBrowserPrivateMode = null;
      await closeSessionBounded(previous);
    }

    const session: ManagedBrowserSession = {
      ...createBrowserSession({ privateMode }),
      sessionId: nextSessionId++,
      generation: nextGeneration++,
      lifecycle: 'starting',
      closePromise: null,
    };
    sharedBrowserSession = session;
    sharedBrowserHeadless = headless;
    sharedBrowserPrivateMode = privateMode;
    emit(onEvent, 'starting', session);
    return session;
  }

  async function ensureBrowserSessionInternal(state: any, onEvent?: (payload: any) => void) {
    const privateMode = state.privateMode === true;
    if (
      state.browserSession
      && isCurrentSession(state.browserSession)
      && Boolean(state.browserSession.privateMode) === privateMode
    ) {
      return state.browserSession as ManagedBrowserSession;
    }
    state.browserSession = null;

    const session = await getSharedBrowserSessionInternal(state.headless === true, privateMode, onEvent);
    const generation = session.generation;
    try {
      session.lifecycle = 'busy';
      await Promise.resolve(session.view.navigate('about:blank'));
      await Promise.resolve(session.view.evaluate('document.readyState'));
      assertCurrentSession(session, generation);
      session.lifecycle = 'ready';
    } catch (err: any) {
      session.lifecycle = 'broken';
      if (session === sharedBrowserSession) {
        sharedBrowserSession = null;
        sharedBrowserHeadless = null;
        sharedBrowserPrivateMode = null;
      }
      await closeSessionBounded(session);
      const detail = String(err?.message || err);
      emit(onEvent, 'degraded', session, { reason: 'initialization_failed', error: detail });
      throw new Error(`WebView 初始化失败: ${detail}`, { cause: err });
    }

    state.browserSession = session;
    onEvent?.({
      type: 'status',
      status: 'browser_ready',
      message: process.platform === 'win32'
        ? 'Microsoft Edge Headless 浏览器已启动并通过健康检查'
        : 'Bun.WebView 浏览器已启动并通过健康检查',
      sessionId: session.sessionId,
      generation: session.generation,
      privateMode: Boolean(session.privateMode),
    });
    emit(onEvent, 'ready', session, { url: 'about:blank', healthChecked: true });
    return session;
  }

  async function resetBrowserSessionInternal(state?: any) {
    const stateSession = (state?.browserSession || null) as ManagedBrowserSession | null;
    const session = stateSession || sharedBrowserSession;
    if (state) state.browserSession = null;
    if (session && session === sharedBrowserSession) {
      sharedBrowserSession = null;
      sharedBrowserHeadless = null;
      sharedBrowserPrivateMode = null;
    }
    if (session) {
      if (session.lifecycle !== 'broken') session.lifecycle = 'closing';
      await closeSessionBounded(session);
    }
  }

  async function cleanupBrowserSessionInternal(state?: any) {
    const session = (state?.browserSession || sharedBrowserSession) as ManagedBrowserSession | null;
    if (!session?.view || !isCurrentSession(session)) return;
    if (session.privateMode) {
      // 隐私会话不能跨任务复用：关闭 WebView 才会删除一次性 profile。
      await resetBrowserSessionInternal(state);
      return;
    }
    const generation = session.generation;
    try {
      session.lifecycle = 'busy';
      await Promise.resolve(session.view.navigate('about:blank'));
      await Promise.resolve(session.view.evaluate('document.readyState'));
      assertCurrentSession(session, generation);
      session.lifecycle = 'ready';
    } catch {
      session.lifecycle = 'broken';
      await resetBrowserSessionInternal(state);
    }
  }

  async function withBrowserSessionRecoveryInternal(
    state: any,
    onEvent: ((payload: any) => void) | undefined,
    operation: (session: ManagedBrowserSession, recoveryAttempt: number) => Promise<any>,
    context: any = {},
  ) {
    // 每个动作最多经历一次重建重试；连续两次恢复失败后打开本 run 熔断，
    // 避免 planner 在坏会话上无限循环并持续产生副作用。
    if (state.browserCircuitOpen) {
      emit(onEvent, 'degraded', state.browserSession, { ...context, reason: 'circuit_open', recoveryFailures: state.browserRecoveryFailures || 0 });
      return circuitOpenResult();
    }

    let session = await ensureBrowserSessionInternal(state, onEvent);
    let generation = session.generation;
    session.lifecycle = 'busy';
    emit(onEvent, 'navigating', session, context);
    try {
      const result = await operation(session, 0);
      assertCurrentSession(session, generation);
      const preview = state.runId && state.privateMode !== true
        ? await captureBrowserPreview(session.view, {
            runId: state.runId,
            privateMode: state.privateMode === true,
          }).catch(() => null)
        : null;
      assertCurrentSession(session, generation);
      session.lifecycle = 'ready';
      state.browserRecoveryFailures = 0;
      emit(onEvent, 'ready', session, { ...context, ...preview });
      return result;
    } catch (err: any) {
      if (!isRecoverableSessionError(err)) {
        if (isCurrentSession(session, generation)) session.lifecycle = 'ready';
        emit(onEvent, 'degraded', session, { ...context, reason: String(err?.message || err).slice(0, 160) });
        throw err;
      }

      session.lifecycle = 'broken';
      const recoveryReason = err?.code === 'BROWSER_SESSION_INVALID' ? 'navigation_timeout' : 'view_closed';
      emit(onEvent, 'recovering', session, { ...context, reason: recoveryReason, retry: 1 });
      await resetBrowserSessionInternal(state);
      session = await ensureBrowserSessionInternal(state, onEvent);
      generation = session.generation;
      session.lifecycle = 'busy';
      try {
        const result = await operation(session, 1);
        assertCurrentSession(session, generation);
        const preview = state.runId && state.privateMode !== true
          ? await captureBrowserPreview(session.view, {
              runId: state.runId,
              privateMode: state.privateMode === true,
            }).catch(() => null)
          : null;
        assertCurrentSession(session, generation);
        session.lifecycle = 'ready';
        state.browserRecoveryFailures = 0;
        emit(onEvent, 'ready', session, { ...context, ...preview, recreated: true, retry: 1 });
        return result;
      } catch (retryErr: any) {
        session.lifecycle = 'broken';
        await resetBrowserSessionInternal(state);
        state.browserRecoveryFailures = (state.browserRecoveryFailures || 0) + 1;
        state.browserCircuitOpen = state.browserRecoveryFailures >= MAX_RECOVERY_FAILURES_PER_RUN;
        emit(onEvent, 'degraded', session, {
          ...context,
          reason: String(retryErr?.message || retryErr).slice(0, 160),
          retry: 1,
          recoveryFailures: state.browserRecoveryFailures,
          circuitOpen: state.browserCircuitOpen,
        });
        if (state.browserCircuitOpen) return circuitOpenResult();
        throw retryErr;
      }
    }
  }

  return {
    serializeBrowserOperation: <T>(operation: () => Promise<T>) => enqueue(operation),
    getSharedBrowserSession: (headless: boolean, onEvent?: (payload: any) => void, privateMode = false) => (
      enqueue(() => getSharedBrowserSessionInternal(headless === true, privateMode === true, onEvent))
    ),
    ensureBrowserSession: (state: any, onEvent?: (payload: any) => void) => (
      enqueue(() => ensureBrowserSessionInternal(state, onEvent))
    ),
    resetBrowserSession: (state?: any) => enqueue(() => resetBrowserSessionInternal(state)),
    cleanupBrowserSession: (state?: any) => enqueue(() => cleanupBrowserSessionInternal(state)),
    withBrowserSessionRecovery: (
      state: any,
      onEvent: ((payload: any) => void) | undefined,
      operation: (session: ManagedBrowserSession, recoveryAttempt: number) => Promise<any>,
      context: any = {},
    ) => enqueue(() => withBrowserSessionRecoveryInternal(state, onEvent, operation, context)),
  };
}
