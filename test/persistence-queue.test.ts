import { describe, expect, it } from 'vitest';
import { createPersistenceQueue, flushAllPersistenceTasks } from '../helpers/persistence-queue.ts';

describe('persistence queue', () => {
  it('serializes tasks and flushes everything enqueued before completion', async () => {
    const queue = createPersistenceQueue();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = queue.enqueue(async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await queue.flush();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues after a failed persistence task', async () => {
    const queue = createPersistenceQueue();
    const failed = queue.enqueue(async () => { throw new Error('disk failed'); });
    const next = queue.enqueue(async () => 'saved');

    await expect(failed).rejects.toThrow('disk failed');
    await expect(next).resolves.toBe('saved');
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it('allows server shutdown to flush active persistence tasks', async () => {
    const queue = createPersistenceQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let saved = false;
    queue.enqueue(async () => {
      await gate;
      saved = true;
    });

    const flushing = flushAllPersistenceTasks();
    await Promise.resolve();
    expect(saved).toBe(false);
    release();
    await flushing;
    expect(saved).toBe(true);
  });
});
