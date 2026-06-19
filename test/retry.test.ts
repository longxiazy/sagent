import { describe, it, expect, vi, afterEach } from 'vitest';
import { retryAsync } from '../helpers/retry.ts';

afterEach(() => { vi.useRealTimers(); });

function rateLimitError() {
  const err: any = new Error('{"error":{"code":429,"message":"quota exceeded"}}');
  err.status = 429;
  return err;
}

describe('retryAsync 限流处理', () => {
  it('retryRateLimit=false 时 429 立即上抛，不退避重试', async () => {
    let calls = 0;
    await expect(
      retryAsync(
        () => { calls += 1; return Promise.reject(rateLimitError()); },
        4,
        undefined,
        { retryRateLimit: false },
      ),
    ).rejects.toThrow(/429|quota/);
    // 不重试 → 仅调用一次，真实 429 错误立即上抛（不会被单步超时掩盖）
    expect(calls).toBe(1);
  });

  it('默认会重试 429（最终仍失败则抛出真实错误）', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = retryAsync(() => { calls += 1; return Promise.reject(rateLimitError()); }, 1);
    const assertion = expect(p).rejects.toThrow(/429|quota/);
    await vi.runAllTimersAsync();
    await assertion;
    // maxRetries=1 → 首次 + 1 次重试 = 2 次调用
    expect(calls).toBe(2);
  });

  it('retryRateLimit=false 仍会重试 5xx 等瞬时错误', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = retryAsync(
      () => {
        calls += 1;
        if (calls < 2) {
          const err: any = new Error('server error');
          err.status = 503;
          return Promise.reject(err);
        }
        return Promise.resolve('ok');
      },
      4,
      undefined,
      { retryRateLimit: false },
    );
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});
