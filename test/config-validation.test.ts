import { describe, it, expect } from 'vitest';
import { computeDefaults, validateConfig, mergeConfig } from '../agent/core/config-store.js';

describe('config validation and effective defaults', () => {
  it('内置默认值（与改造前各处默认一致）', () => {
    const d = computeDefaults();
    expect(d).toEqual({
      maxSteps: 8,
      modelTimeoutSec: 90,
      maxOutputTokens: 4096,
      staggerDelaySec: 5,
      batchSize: 1,
      observeDesktop: false,
      maxHistorySteps: 6,
      maxResultChars: 4000,
      autoModelRouting: false,
    });
  });
});

describe('validateConfig', () => {
  it('接受合法整数与布尔', () => {
    const { clean, errors } = validateConfig({ maxSteps: 10, observeDesktop: true });
    expect(errors).toEqual([]);
    expect(clean).toEqual({ maxSteps: 10, observeDesktop: true });
  });

  it('字符串数字会被转换', () => {
    const { clean, errors } = validateConfig({ maxSteps: '12' });
    expect(errors).toEqual([]);
    expect(clean.maxSteps).toBe(12);
  });

  it('忽略未知键', () => {
    const { clean, errors } = validateConfig({ foo: 1, maxSteps: 5 });
    expect(errors).toEqual([]);
    expect(clean).toEqual({ maxSteps: 5 });
  });

  it('拒绝超出范围（含原因）', () => {
    const { clean, errors } = validateConfig({ maxSteps: 0 });
    expect(clean.maxSteps).toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('maxSteps');
  });

  it('拒绝非整数', () => {
    expect(validateConfig({ batchSize: 1.5 }).errors.length).toBe(1);
  });

  it('observeDesktop 非布尔被拒', () => {
    expect(validateConfig({ observeDesktop: 'yes' }).errors.length).toBe(1);
  });

  it('autoModelRouting 接受布尔并拒绝非布尔', () => {
    expect(validateConfig({ autoModelRouting: true }).clean.autoModelRouting).toBe(true);
    expect(validateConfig({ autoModelRouting: 'true' }).errors.length).toBe(1);
  });

  it('staggerDelaySec 允许 0', () => {
    const { clean, errors } = validateConfig({ staggerDelaySec: 0 });
    expect(errors).toEqual([]);
    expect(clean.staggerDelaySec).toBe(0);
  });

  it('非对象返回错误', () => {
    expect(validateConfig(null).errors.length).toBe(1);
  });
});

describe('mergeConfig', () => {
  const defaults = computeDefaults();

  it('overrides 覆盖默认，其余保持', () => {
    const m = mergeConfig(defaults, { maxSteps: 3 });
    expect(m.maxSteps).toBe(3);
    expect(m.batchSize).toBe(defaults.batchSize);
  });

  it('空 overrides 返回默认副本（非同一引用）', () => {
    const m = mergeConfig(defaults, {});
    expect(m).toEqual(defaults);
    expect(m).not.toBe(defaults);
  });

  it('忽略未知键', () => {
    const m: any = mergeConfig(defaults, { foo: 1 } as any);
    expect(m.foo).toBeUndefined();
  });

  it('覆盖 staggerDelaySec=0 生效（不被当成缺省）', () => {
    expect(mergeConfig(defaults, { staggerDelaySec: 0 }).staggerDelaySec).toBe(0);
  });
});
