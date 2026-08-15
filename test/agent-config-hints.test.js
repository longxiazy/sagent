import { describe, expect, it } from 'vitest';
import { multiModelTuningIdle } from '../client/src/utils/agent-config-hints.js';

// besteffort 档的取值：并发 2、错峰 10s，容错完全依赖多模型补位。
const BEST_EFFORT = { batchSize: 2, staggerDelaySec: 10 };
// economy 档：本就按单模型串行设计，但错峰仍是多模型才用得上的参数。
const ECONOMY = { batchSize: 1, staggerDelaySec: 60 };

describe('multi-model tuning idle hint', () => {
  it('warns when a fallback-oriented profile runs on a single model', () => {
    expect(multiModelTuningIdle({ modelCount: 1, ...BEST_EFFORT })).toBe(true);
  });

  it('warns on a single model whenever stagger delay is set, even at batch size 1', () => {
    expect(multiModelTuningIdle({ modelCount: 1, ...ECONOMY })).toBe(true);
  });

  it('stays quiet once a second model is selected', () => {
    expect(multiModelTuningIdle({ modelCount: 2, ...BEST_EFFORT })).toBe(false);
  });

  it('stays quiet when neither knob is in play', () => {
    expect(multiModelTuningIdle({ modelCount: 1, batchSize: 1, staggerDelaySec: 0 })).toBe(false);
  });

  it('stays quiet before the user has picked any model', () => {
    expect(multiModelTuningIdle({ modelCount: 0, ...BEST_EFFORT })).toBe(false);
  });

  it('tolerates missing or non-numeric config values', () => {
    expect(multiModelTuningIdle()).toBe(false);
    expect(multiModelTuningIdle({ modelCount: 1 })).toBe(false);
    expect(multiModelTuningIdle({ modelCount: 1, batchSize: null, staggerDelaySec: undefined })).toBe(false);
  });
});
