/**
 * Shared built-in browser session manager.
 *
 * A WebView belongs to one run and is reused only within that run. Navigation and
 * observation are serialized; cancellation closes the view outside that queue so
 * a pending browser operation cannot keep media playing. Every run closes its view
 * on cleanup. Normal profiles persist; private profiles are removed on close.
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
  ownerState?: any;
  removeAbortListener?: (() => void) | null;
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
  const finishedStates = new WeakSet<object>();

  function throwIfRunStopped(state?: any) {
    if (state?.cancelSignal?.aborted) {
      // runtime/路由以这条消息识别取消；保留底层 reason，避免关闭异常被记成任务失败。
      throw new Error('Agent 已取消', { cause: state.cancelSignal.reason });
    }
    if (state && finishedStates.has(state)) {
      throw new Error('任务已结束，不能继续使用内置浏览器');
    }
  }

  async function withCancellation<T>(state: any, operation: () => Promise<T>): Promise<T> {
    throwIfRunStopped(state);
    const signal: AbortSignal | undefined = state?.cancelSignal;
    if (!signal) return operation();
    let onAbort: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Agent 已取消', { cause: signal.reason }));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      // 先接管两个 Promise 再执行回调，回调同步抛错/触发取消时也不会留下未处理的拒绝。
      const pending = Promise.resolve().then(() => {
        throwIfRunStopped(state);
        return operation();
      });
      return await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

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

  const enqueue = <T>(operation: () => Promise<T>, state?: any): Promise<T> => {
    // 排队时可立即取消；执行中也与取消竞速，防止原生 close 后仍不落定的 Promise 堵住后续任务。
    // 底层调用晚到的结果仍由各 await 后的检查拦截，不能恢复已取消的会话。
    const run = () => withCancellation(state, operation);
    const queued = operationQueue.then(run, run);
    operationQueue = queued.then(() => undefined, () => undefined);
    return withCancellation(state, () => queued);
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
    session.removeAbortListener?.();
    session.removeAbortListener = null;
    let timer: ReturnType<typeof setTimeout>;
    const closeTask = Promise.resolve(closeBrowserSession(session)).catch(() => {});
    session.closePromise = Promise.race([
      closeTask,
      new Promise<void>(resolve => { timer = setTimeout(resolve, closeTimeoutMs); }),
    ]).then(() => {
      session.lifecycle = 'closed';
      // 旧任务的延迟清理只能释放自己的引用，不能清掉后来建立的会话。
      if (session.ownerState?.browserSession === session) session.ownerState.browserSession = null;
    }).finally(() => {
      clearTimeout(timer);
    });
    await session.closePromise;
  }

  async function getSharedBrowserSessionInternal(headless: boolean, privateMode: boolean, onEvent?: (payload: any) => void, state?: any) {
    throwIfRunStopped(state);
    // 除运行模式外还校验任务归属：跨任务仅复用磁盘 profile，不复用正在运行的页面。
    if (
      sharedBrowserSession
      && sharedBrowserSession.ownerState === state
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

    // 关闭旧实例期间也可能收到取消，必须在构造新 WebView 前再检查一次。
    throwIfRunStopped(state);
    const session: ManagedBrowserSession = {
      ...createBrowserSession({ privateMode }),
      sessionId: nextSessionId++,
      generation: nextGeneration++,
      lifecycle: 'starting',
      closePromise: null,
      ownerState: state,
    };
    sharedBrowserSession = session;
    sharedBrowserHeadless = headless;
    sharedBrowserPrivateMode = privateMode;
    if (state) {
      // 在第一次异步导航之前登记归属并绑定取消；监听覆盖等待模型/审批等非浏览器阶段。
      state.browserSession = session;
      const signal: AbortSignal | undefined = state.cancelSignal;
      const onAbort = () => { void resetBrowserSessionInternal(state); };
      signal?.addEventListener('abort', onAbort, { once: true });
      session.removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        onAbort();
        throwIfRunStopped(state);
      }
    }
    emit(onEvent, 'starting', session);
    return session;
  }

  async function ensureBrowserSessionInternal(state: any, onEvent?: (payload: any) => void) {
    throwIfRunStopped(state);
    const privateMode = state.privateMode === true;
    if (
      state.browserSession
      && isCurrentSession(state.browserSession)
      && Boolean(state.browserSession.privateMode) === privateMode
    ) {
      return state.browserSession as ManagedBrowserSession;
    }
    state.browserSession = null;

    const session = await getSharedBrowserSessionInternal(state.headless === true, privateMode, onEvent, state);
    const generation = session.generation;
    try {
      throwIfRunStopped(state);
      session.lifecycle = 'busy';
      await Promise.resolve(session.view.navigate('about:blank'));
      throwIfRunStopped(state);
      await Promise.resolve(session.view.evaluate('document.readyState'));
      throwIfRunStopped(state);
      assertCurrentSession(session, generation);
      session.lifecycle = 'ready';
    } catch (err: any) {
      if (isCurrentSession(session, generation)) session.lifecycle = 'broken';
      if (session === sharedBrowserSession) {
        sharedBrowserSession = null;
        sharedBrowserHeadless = null;
        sharedBrowserPrivateMode = null;
      }
      await closeSessionBounded(session);
      throwIfRunStopped(state);
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
    throwIfRunStopped(state);
    emit(onEvent, 'ready', session, { url: 'about:blank', healthChecked: true });
    return session;
  }

  async function resetBrowserSessionInternal(state?: any) {
    // 传入 state 时只清理该任务自己的会话；没有浏览器的任务不能回退关闭别人的 WebView。
    const session = (state ? state.browserSession : sharedBrowserSession) as ManagedBrowserSession | null;
    if (session && session === sharedBrowserSession) {
      sharedBrowserSession = null;
      sharedBrowserHeadless = null;
      sharedBrowserPrivateMode = null;
    }
    if (session) {
      // 关闭期间保留 state 引用，让取消和 finally 清理都能等待同一个有超时上限的 closePromise。
      await closeSessionBounded(session);
    }
  }

  async function cleanupBrowserSessionInternal(state?: any) {
    // 成功、失败和取消都关闭页面；普通 profile 保留登录数据，隐私 profile 由适配器删除。
    // 先标记任务结束，拦截仍在排队或迟到的浏览器操作，避免清理之后重新打开页面。
    if (state) finishedStates.add(state);
    await resetBrowserSessionInternal(state);
  }

  async function withBrowserSessionRecoveryInternal(
    state: any,
    onEvent: ((payload: any) => void) | undefined,
    operation: (session: ManagedBrowserSession, recoveryAttempt: number) => Promise<any>,
    context: any = {},
  ) {
    throwIfRunStopped(state);
    // 每个动作最多经历一次重建重试；连续两次恢复失败后打开本 run 熔断，
    // 避免 planner 在坏会话上无限循环并持续产生副作用。
    if (state.browserCircuitOpen) {
      emit(onEvent, 'degraded', state.browserSession, { ...context, reason: 'circuit_open', recoveryFailures: state.browserRecoveryFailures || 0 });
      return circuitOpenResult();
    }

    let session = await ensureBrowserSessionInternal(state, onEvent);
    throwIfRunStopped(state);
    let generation = session.generation;
    session.lifecycle = 'busy';
    emit(onEvent, 'navigating', session, context);
    try {
      throwIfRunStopped(state);
      const result = await operation(session, 0);
      throwIfRunStopped(state);
      assertCurrentSession(session, generation);
      const preview = state.runId && state.privateMode !== true
        ? await captureBrowserPreview(session.view, {
            runId: state.runId,
            privateMode: state.privateMode === true,
          }).catch(() => null)
        : null;
      throwIfRunStopped(state);
      assertCurrentSession(session, generation);
      session.lifecycle = 'ready';
      state.browserRecoveryFailures = 0;
      emit(onEvent, 'ready', session, { ...context, ...preview });
      return result;
    } catch (err: any) {
      // 用户关闭 WebView 导致的 closed/stale 异常属于取消，不能进入自动恢复并再次启动浏览器。
      throwIfRunStopped(state);
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
      throwIfRunStopped(state);
      generation = session.generation;
      session.lifecycle = 'busy';
      try {
        const result = await operation(session, 1);
        throwIfRunStopped(state);
        assertCurrentSession(session, generation);
        const preview = state.runId && state.privateMode !== true
          ? await captureBrowserPreview(session.view, {
              runId: state.runId,
              privateMode: state.privateMode === true,
            }).catch(() => null)
          : null;
        throwIfRunStopped(state);
        assertCurrentSession(session, generation);
        session.lifecycle = 'ready';
        state.browserRecoveryFailures = 0;
        emit(onEvent, 'ready', session, { ...context, ...preview, recreated: true, retry: 1 });
        return result;
      } catch (retryErr: any) {
        throwIfRunStopped(state);
        session.lifecycle = 'broken';
        await resetBrowserSessionInternal(state);
        throwIfRunStopped(state);
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
    serializeBrowserOperation: <T>(operation: () => Promise<T>, state?: any) => enqueue(operation, state),
    getSharedBrowserSession: (headless: boolean, onEvent?: (payload: any) => void, privateMode = false) => (
      enqueue(() => getSharedBrowserSessionInternal(headless === true, privateMode === true, onEvent))
    ),
    ensureBrowserSession: (state: any, onEvent?: (payload: any) => void) => (
      enqueue(() => ensureBrowserSessionInternal(state, onEvent), state)
    ),
    // 关闭是唯一绕过操作队列的动作，才能立即终止卡住的导航和后台音视频。
    resetBrowserSession: resetBrowserSessionInternal,
    cleanupBrowserSession: cleanupBrowserSessionInternal,
    withBrowserSessionRecovery: (
      state: any,
      onEvent: ((payload: any) => void) | undefined,
      operation: (session: ManagedBrowserSession, recoveryAttempt: number) => Promise<any>,
      context: any = {},
    ) => enqueue(() => withBrowserSessionRecoveryInternal(state, onEvent, operation, context), state),
  };
}
