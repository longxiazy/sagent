import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  lastActivityTs,
  sessionMatchesQuery,
  buildGroups,
} from '../client/src/components/session/session-grouping.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi, 0).getTime();

describe('lastActivityTs', () => {
  it('取最后一条带 ts 的消息时间', () => {
    const s = {
      messages: [
        { role: 'user', content: 'a', ts: at(2026, 5, 10) },
        { role: 'assistant', content: 'b', ts: at(2026, 5, 11) },
      ],
      updatedAt: at(2026, 5, 15),
    };
    expect(lastActivityTs(s)).toBe(at(2026, 5, 11));
  });

  it('末条消息缺 ts → 回退上一条带 ts 的消息(绕过被污染的 updatedAt)', () => {
    const s = {
      messages: [
        { role: 'user', content: 'a', ts: at(2026, 5, 10) },
        { role: 'assistant', content: 'b' }, // 流式 assistant 常丢 ts
      ],
      updatedAt: at(2026, 5, 15), // 被 trace 重建刷成更晚的时间
    };
    expect(lastActivityTs(s)).toBe(at(2026, 5, 10));
  });

  it('无任何消息 ts → 回退 updatedAt', () => {
    const s = { messages: [{ role: 'user', content: 'a' }], updatedAt: at(2026, 5, 15), createdAt: at(2026, 5, 1) };
    expect(lastActivityTs(s)).toBe(at(2026, 5, 15));
  });

  it('无消息且无 updatedAt → 回退 createdAt', () => {
    const s = { messages: [], createdAt: at(2026, 5, 1) };
    expect(lastActivityTs(s)).toBe(at(2026, 5, 1));
  });
});

describe('sessionMatchesQuery', () => {
  const s = {
    messages: [
      { role: 'user', content: '帮我写一个 Python 爬虫' },
      { role: 'assistant', content: '好的，这是代码' },
    ],
  };

  it('匹配消息内容(大小写不敏感)', () => {
    expect(sessionMatchesQuery(s, 'python')).toBe(true);
    expect(sessionMatchesQuery(s, '爬虫')).toBe(true);
    expect(sessionMatchesQuery(s, '代码')).toBe(true);
  });

  it('无匹配 → false', () => {
    expect(sessionMatchesQuery(s, 'java')).toBe(false);
  });
});

describe('buildGroups', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  const mk = (id, ts, updatedAt) => ({
    id,
    messages: ts ? [{ role: 'user', content: `消息 ${id}`, ts }] : [],
    updatedAt,
    createdAt: updatedAt,
  });

  it('按时间分组、空组剔除', () => {
    const sessions = [
      mk('a', at(2026, 5, 15, 9, 0)), // 今天
      mk('b', at(2026, 5, 14, 9, 0)), // 昨天
      mk('c', at(2026, 5, 12, 9, 0)), // 近 7 天
      mk('d', at(2026, 4, 1, 9, 0)),  // 更早
    ];
    const groups = buildGroups(sessions, '');
    expect(groups.map(g => g.key)).toEqual(['today', 'yesterday', 'week', 'earlier']);
  });

  it('同组内按最近活动倒序', () => {
    const sessions = [
      mk('old', at(2026, 5, 15, 8, 0)),
      mk('new', at(2026, 5, 15, 11, 0)),
    ];
    const groups = buildGroups(sessions, '');
    expect(groups[0].sessions.map(s => s.id)).toEqual(['new', 'old']);
  });

  it('用消息 ts 而非被污染的 updatedAt 分组(核心修复验证)', () => {
    // updatedAt 被刷成今天，但真实消息在 3 天前 → 应进“近 7 天”而非“今天”
    const sessions = [mk('s', at(2026, 5, 12, 9, 0), at(2026, 5, 15, 12, 0))];
    const groups = buildGroups(sessions, '');
    expect(groups[0].key).toBe('week');
  });

  it('搜索过滤命中会话', () => {
    const a = mk('a', at(2026, 5, 15, 9, 0));
    a.messages = [{ role: 'user', content: 'apple pie', ts: at(2026, 5, 15, 9, 0) }];
    const b = mk('b', at(2026, 5, 15, 9, 0));
    b.messages = [{ role: 'user', content: 'banana split', ts: at(2026, 5, 15, 9, 0) }];
    const groups = buildGroups([a, b], 'APPLE');
    expect(groups.length).toBe(1);
    expect(groups[0].sessions.map(s => s.id)).toEqual(['a']);
  });
});
