export type AbortScope = {
  signal: AbortSignal;
  deadline: number | null;
  cleanup(): void;
};

function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : fallback);
}
export function throwIfAborted(signal?: AbortSignal | null, fallback = 'Agent 已取消'): void {
  if (signal?.aborted) throw abortReason(signal, fallback);
}

/** 将父级取消、绝对 deadline 和局部 timeout 合并为单一 AbortSignal。 */
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
