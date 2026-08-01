import { describe, it, expect } from 'vitest';
import { computeDefaults, validateConfig, mergeConfig } from '../agent/core/config-store.js';
import { detectProfile, resolveProfileValues, collectConfigWarnings, PROFILE_MATCH_ORDER } from '../agent/core/config-schema.ts';

describe('config validation and effective defaults', () => {
  it('内置默认值（与改造前各处默认一致）', () => {
    const d = computeDefaults();
    expect(d).toEqual({
      maxSteps: 8,
      modelTimeoutSec: 90,
      maxOutputTokens: 4096,
      staggerDelaySec: 60,
      batchSize: 1,
      observeDesktop: false,
      maxHistorySteps: 8,
      maxResultChars: 4096,
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

describe('detectProfile: 由生效值反推档位', () => {
  it('内置默认值归到 economy，而不是 custom', () => {
    // 全新环境从未写过 config.json，此时生效值即内置默认；
    // 若归到 custom，界面上会没有任何档位被选中。
    expect(detectProfile(computeDefaults())).toBe('economy');
  });

  it('每个档位的完整取值都能被反推回自身', () => {
    for (const profile of PROFILE_MATCH_ORDER) {
      expect(detectProfile(resolveProfileValues(profile))).toBe(profile);
    }
  });

  it('任一参数偏离档位取值即为 custom', () => {
    const values = { ...resolveProfileValues('deep'), maxSteps: 31 };
    expect(detectProfile(values)).toBe('custom');
  });

  it('从 custom 改回某档位的取值会回到该档位', () => {
    const fast = resolveProfileValues('fast');
    expect(detectProfile({ ...fast, maxSteps: 99 })).toBe('custom');
    expect(detectProfile(fast)).toBe('fast');
  });

  it('档位展开后包含全部字段，未声明的继承内置默认', () => {
    const defaults = computeDefaults();
    const fast = resolveProfileValues('fast');
    expect(Object.keys(fast).sort()).toEqual(Object.keys(defaults).sort());
    // fast 未声明 observeDesktop，应继承内置默认。
    expect(fast.observeDesktop).toBe(defaults.observeDesktop);
  });
});

describe('collectConfigWarnings: 搭配失效提示', () => {
  it('历史窗口大于最大步数时给出警告', () => {
    const values = { ...computeDefaults(), maxSteps: 6, maxHistorySteps: 16 };
    const warnings = collectConfigWarnings(values);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      key: 'maxHistorySteps',
      code: 'historyExceedsSteps',
      params: { maxSteps: 6, maxHistorySteps: 16 },
    });
  });

  it('历史窗口等于或小于最大步数时无警告', () => {
    expect(collectConfigWarnings({ ...computeDefaults(), maxSteps: 8, maxHistorySteps: 8 })).toEqual([]);
    expect(collectConfigWarnings({ ...computeDefaults(), maxSteps: 32, maxHistorySteps: 16 })).toEqual([]);
  });

  it('四档预设本身都不触发警告', () => {
    for (const profile of PROFILE_MATCH_ORDER) {
      expect(collectConfigWarnings(resolveProfileValues(profile))).toEqual([]);
    }
  });
});
