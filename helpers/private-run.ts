import { AsyncLocalStorage } from 'node:async_hooks';

interface PrivateRunContext {
  privateMode: boolean;
}

const privateRunStorage = new AsyncLocalStorage<PrivateRunContext>();

/**
 * 在一次 Agent 运行的异步调用链中标记隐私模式。
 *
 * 运行期间仍可以把事件发送到当前页面；已接入该上下文的持久化适配器
 * （普通日志、LLM 日志、trace、checkpoint 等）会跳过磁盘写入。
 */
export function withPrivateRun<T>(privateMode: boolean, fn: () => T): T {
  // 嵌套调用不能用 false 关闭外层隐私标记，避免异步子流程意外恢复写盘。
  const inheritedPrivateMode = privateRunStorage.getStore()?.privateMode === true;
  return privateRunStorage.run({ privateMode: inheritedPrivateMode || privateMode === true }, fn);
}

export function isPrivateRun(): boolean {
  return privateRunStorage.getStore()?.privateMode === true;
}
