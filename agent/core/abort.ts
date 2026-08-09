/**
 * Agent 取消/超时统一工具。
 * throwIfAborted 在异步操作检查点做取消检查;createAbortScope 将用户取消、
 * deadline、局部超时合并为单一 AbortSignal 传给模型请求与 IO。
 */
export type AbortScope = {
  signal: AbortSignal;
  deadline: number | null;
  cleanup(): void;
};

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : fallback);
}
/**
 * signal 已中止时抛出中止错误,否则无操作。
 * 用法：在异步操作的关键检查点调用,取消后立即中断并保留原始 reason。
 * 当前使用：fs/execute.ts、terminal/run.ts 等工具执行的循环检查点,
 * vision/execute.ts 与 desktop/planner/single-model.ts 的 scope.signal 检查。
 */
export function throwIfAborted(signal?: AbortSignal | null, fallback = 'Agent 已取消'): void {
  if (signal?.aborted) throw abortReason(signal, fallback);
}

/**
 * 将父级取消、绝对 deadline 和局部 timeout 合并为单一 AbortSignal。
 * 用法：把多个取消来源合并后传给模型请求/IO;结束后必须在 finally 中调用 scope.cleanup() 释放监听与定时器。
 * 当前使用：vision/execute.ts（图片下载与 image_analyze 请求,221/299）、
 * search/execute.ts（web_search 请求,122）、
 * desktop/planner/single-model.ts（三路信号竞速与模型超时,47/81）。
 */
export function createAbortScope({
  signals = [],
  deadline = null,
  timeoutMs,
  timeoutMessage = '操作超时',
}: {
  signals?: Array<AbortSignal | null | undefined>;
  deadline?: number | null;
  timeoutMs?: number;
  timeoutMessage?: string;
} = {}): AbortScope {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let timer: NodeJS.Timeout | null = null;
  const timeoutDeadline = Number.isFinite(timeoutMs) && Number(timeoutMs) >= 0
    ? Date.now() + Number(timeoutMs)
    : null;
  const effectiveDeadline = [deadline, timeoutDeadline]
    .filter((value): value is number => Number.isFinite(value))
    .reduce<number | null>((earliest, value) => earliest == null ? value : Math.min(earliest, value), null);

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort(signal.reason || new Error('Agent 已取消'));
      break;
    }
    const listener = () => abort(signal.reason || new Error('Agent 已取消'));
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  if (!controller.signal.aborted && effectiveDeadline != null) {
    const remainingMs = Math.max(0, effectiveDeadline - Date.now());
    timer = setTimeout(() => abort(new Error(timeoutMessage)), remainingMs);
  }

  return {
    signal: controller.signal,
    deadline: effectiveDeadline,
    cleanup() {
      if (timer) clearTimeout(timer);
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    },
  };
}