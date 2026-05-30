/**
 * Browser Lock — 浏览器工具的进程级串行化互斥锁。
 *
 * 背景：Chrome MCP 是进程单例（mcp-client.ts 的 sharedClientPromise），
 * 且 execute.ts 的 currentSnapshotId 是模块级单变量。多个 agent run 并发操作
 * 浏览器会互相覆盖 page 选择和 snapshot id，导致点错元素 / 抓错页面。
 *
 * 方案：所有浏览器动作经由 withBrowserLock 串行执行 —— 同一时刻只有一个 run
 * 持锁操作浏览器，其余排队。非浏览器任务（聊天/文件/终端）不受影响，仍真并发。
 *
 * 这是一个公平队列（FIFO）：先请求先获得锁。
 */

import { log } from '../../../helpers/logger.ts';

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

let locked = false;
const queue: Waiter[] = [];

function dispatchNext() {
  if (locked) return;
  const next = queue.shift();
  if (!next) return;
  if (next.signal?.aborted) {
    // 该等待者已被取消，跳过它继续派发下一个
    next.reject(new Error('Agent 已取消'));
    dispatchNext();
    return;
  }
  if (next.onAbort && next.signal) {
    next.signal.removeEventListener('abort', next.onAbort);
  }
  locked = true;
  next.resolve();
}

/**
 * 获取浏览器锁。返回一个 release 函数，必须在 finally 中调用。
 * 若传入 cancelSignal 且在排队期间被 abort，acquire 会 reject('Agent 已取消')，
 * 让被取消的任务尽快放弃排队、不再占用后续锁。
 */
function acquire(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const release = () => {
      if (!locked) return;
      locked = false;
      dispatchNext();
    };

    if (!locked && queue.length === 0) {
      locked = true;
      resolve(release);
      return;
    }

    if (signal?.aborted) {
      reject(new Error('Agent 已取消'));
      return;
    }

    const waiter: Waiter = {
      resolve: () => resolve(release),
      reject,
    };
    if (signal) {
      waiter.signal = signal;
      waiter.onAbort = () => {
        const idx = queue.indexOf(waiter);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new Error('Agent 已取消'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    queue.push(waiter);
  });
}

/**
 * 在浏览器锁保护下执行 fn。获取锁 → 执行 → 无论成功失败都释放锁。
 * @param fn 持锁期间执行的浏览器操作
 * @param opts.signal 可选取消信号；排队中被 abort 则放弃执行
 * @param opts.onRelease 释放锁前的回调（如重置 snapshot 状态），始终执行
 */
export async function withBrowserLock<T>(
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; onRelease?: () => void } = {},
): Promise<T> {
  const release = await acquire(opts.signal);
  if (queue.length > 0) {
    log.debug(`[BrowserLock] acquired, ${queue.length} waiting`);
  }
  try {
    return await fn();
  } finally {
    try {
      opts.onRelease?.();
    } catch (err: any) {
      log.warn(`[BrowserLock] onRelease failed: ${err?.message || err}`);
    }
    release();
  }
}

/** 仅供测试：重置锁状态 */
export function __resetBrowserLockForTest() {
  locked = false;
  queue.length = 0;
}
