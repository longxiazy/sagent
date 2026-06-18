import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calendarDaysAgo,
  formatFullTime,
  formatShortTime,
  formatRelativeTime,
} from '../client/src/utils/format.js';

// 用本地时间构造时间戳，断言与运行时区无关（构造与格式化都走本地时区）。
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi, 0).getTime();

describe('formatFullTime / formatShortTime', () => {
  it('完整时间 → YYYY-MM-DD HH:mm', () => {
    expect(formatFullTime(at(2026, 5, 15, 14, 30))).toBe('2026-06-15 14:30');
    expect(formatFullTime(at(2026, 0, 3, 9, 5))).toBe('2026-01-03 09:05');
  });

  it('短时间 → MM-DD HH:mm', () => {
    expect(formatShortTime(at(2026, 5, 15, 14, 30))).toBe('06-15 14:30');
  });

  it('空/非法值 → 空串', () => {
    expect(formatFullTime(0)).toBe('');
    expect(formatFullTime(null)).toBe('');
    expect(formatShortTime(undefined)).toBe('');
    expect(formatFullTime(NaN)).toBe('');
  });
});

describe('calendarDaysAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it('按本地自然日计算天数差', () => {
    expect(calendarDaysAgo(at(2026, 5, 15, 1, 0))).toBe(0);
    expect(calendarDaysAgo(at(2026, 5, 14, 23, 0))).toBe(1);
    expect(calendarDaysAgo(at(2026, 5, 8, 12, 0))).toBe(7);
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    // 相对时间文案已国际化（按 localStorage 里的语言取词）。
    // node 测试环境无 localStorage，这里 stub 一个固定返回中文的实现使断言确定。
    vi.stubGlobal('localStorage', {
      getItem: key => (key === 'app_lang' ? 'zh' : null),
      setItem: () => {},
      removeItem: () => {},
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('一分钟内 → 刚刚', () => {
    expect(formatRelativeTime(Date.now() - 30 * 1000)).toBe('刚刚');
  });

  it('一小时内 → N分钟前', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60 * 1000)).toBe('5分钟前');
  });

  it('当天更早 → N小时前', () => {
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60 * 1000)).toBe('3小时前');
  });

  it('昨天 → 昨天', () => {
    expect(formatRelativeTime(at(2026, 5, 14, 20, 0))).toBe('昨天');
  });

  it('一周内 → N天前', () => {
    expect(formatRelativeTime(at(2026, 5, 12, 9, 0))).toBe('3天前');
  });

  it('超过 7 天(同年) → MM-DD', () => {
    expect(formatRelativeTime(at(2026, 5, 1, 10, 0))).toBe('06-01');
  });

  it('跨年 → YYYY-MM-DD', () => {
    expect(formatRelativeTime(at(2025, 11, 25, 10, 0))).toBe('2025-12-25');
  });

  it('未来时间(时钟漂移) → 回退完整时间', () => {
    const future = Date.now() + 60 * 60 * 1000;
    expect(formatRelativeTime(future)).toBe(formatFullTime(future));
  });

  it('空值 → 空串', () => {
    expect(formatRelativeTime(0)).toBe('');
    expect(formatRelativeTime(null)).toBe('');
  });
});
