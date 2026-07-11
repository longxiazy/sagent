export interface PersistenceQueue {
  enqueue<T>(task: () => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

const activePersistenceTasks = new Set<Promise<void>>();

function trackPersistenceTask<T>(promise: Promise<T>): Promise<T> {
  const tracked = promise.then(() => undefined, () => undefined);
  activePersistenceTasks.add(tracked);
  tracked.finally(() => activePersistenceTasks.delete(tracked));
  return promise;
}

export async function flushAllPersistenceTasks(): Promise<void> {
  while (activePersistenceTasks.size > 0) {
    await Promise.all([...activePersistenceTasks]);
  }
}
/** 单消费者 Promise 链：保证同一 Run 的落盘操作严格按入队顺序执行。 */
export function createPersistenceQueue(): PersistenceQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(task: () => T | Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(() => undefined, () => undefined);
      return trackPersistenceTask(result);
    },
    async flush() {
      await tail;
    },
  };
}
