import { describe, it, expect, beforeEach } from 'vitest';
import { withBrowserLock, __resetBrowserLockForTest } from '../agent/tools/chrome/browser-lock.ts';

beforeEach(() => {
  __resetBrowserLockForTest();
});

describe('browser-lock', () => {
  it('serializes concurrent operations (no overlap)', async () => {
    const events: string[] = [];
    const make = (id: string) => async () => {
      events.push(`${id}:start`);
      await new Promise(resolve => setTimeout(resolve, 20));
      events.push(`${id}:end`);
      return id;
    };

    // 同时发起三个,锁保证它们串行执行、不交错
    const results = await Promise.all([
      withBrowserLock(make('A')),
      withBrowserLock(make('B')),
      withBrowserLock(make('C')),
    ]);

    expect(results).toEqual(['A', 'B', 'C']);
    // 每个任务的 start 必须紧跟自己的 end,中间不能插入别的任务
    for (let i = 0; i < events.length; i += 2) {
      const id = events[i].split(':')[0];
      expect(events[i]).toBe(`${id}:start`);
      expect(events[i + 1]).toBe(`${id}:end`);
    }
  });

  it('preserves FIFO order', async () => {
    const order: string[] = [];
    await Promise.all(
      ['A', 'B', 'C', 'D'].map(id =>
        withBrowserLock(async () => {
          order.push(id);
          await new Promise(resolve => setTimeout(resolve, 5));
        }),
      ),
    );
    expect(order).toEqual(['A', 'B', 'C', 'D']);
  });

  it('always releases the lock even if fn throws', async () => {
    await expect(withBrowserLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // 锁应已释放,后续任务能正常拿到锁
    const result = await withBrowserLock(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('runs onRelease after fn (success and failure)', async () => {
    let released = 0;
    await withBrowserLock(async () => 'x', { onRelease: () => { released++; } });
    expect(released).toBe(1);
    await expect(
      withBrowserLock(async () => { throw new Error('e'); }, { onRelease: () => { released++; } }),
    ).rejects.toThrow('e');
    expect(released).toBe(2);
  });

  it('rejects a queued waiter when its signal aborts, without blocking others', async () => {
    const ac = new AbortController();
    const ran: string[] = [];

    // A 持锁较久;B 带可取消 signal 在排队;C 正常排队
    const pA = withBrowserLock(async () => {
      ran.push('A');
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    const pB = withBrowserLock(async () => { ran.push('B'); }, { signal: ac.signal });
    const pC = withBrowserLock(async () => { ran.push('C'); });

    // A 还在跑时取消 B
    await new Promise(resolve => setTimeout(resolve, 10));
    ac.abort();

    await expect(pB).rejects.toThrow('Agent 已取消');
    await pA;
    await pC;

    // B 被取消不执行,A 和 C 正常跑
    expect(ran).toEqual(['A', 'C']);
  });

  it('rejects immediately if signal already aborted while locked', async () => {
    const ac = new AbortController();
    ac.abort();
    // 先占住锁,迫使第二个请求进入"已锁"分支
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const pHold = withBrowserLock(async () => { await hold; });
    await new Promise(resolve => setTimeout(resolve, 5));

    await expect(withBrowserLock(async () => 'x', { signal: ac.signal })).rejects.toThrow('Agent 已取消');

    release();
    await pHold;
  });
});
