import { describe, expect, it } from 'vitest';
import { modelRefreshNote } from '../client/src/utils/model-refresh-note.js';

// 只关心「挑了哪条文案、带了什么数」，不校验译文本身。
const t = (key, vars) => `${key}:${JSON.stringify(vars)}`;

describe('modelRefreshNote', () => {
  it('有增删时报告增删数与总数', () => {
    expect(modelRefreshNote({ added: ['a', 'b'], removed: ['c'], count: 38 }, t))
      .toBe('models.refreshChanged:{"added":2,"removed":1,"count":38}');
  });

  it('拉到了但没变化时也给一句，而不是静默', () => {
    expect(modelRefreshNote({ added: [], removed: [], count: 38 }, t))
      .toBe('models.refreshUnchanged:{"count":38}');
  });

  it('后端没给 count 时退回 models 长度，不显示 0', () => {
    expect(modelRefreshNote({ models: [{ id: 'a' }, { id: 'b' }] }, t))
      .toBe('models.refreshUnchanged:{"count":2}');
  });

  it('结果为空也不炸', () => {
    expect(modelRefreshNote(null, t)).toBe('models.refreshUnchanged:{"count":0}');
  });
});
