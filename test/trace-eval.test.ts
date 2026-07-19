import { describe, expect, it } from 'vitest';
import {
  compareParserOutcomes,
  driftPercent,
  evaluateFixtureAgainstBaseline,
  replayParserCorpus,
  severityMax,
  type FixtureBaseline,
  type FixtureCurrent,
} from '../scripts/trace-eval.ts';

const THRESHOLDS = { warnDrift: 10, failDrift: 25 };

function makeCurrent(overrides: Partial<FixtureCurrent> = {}): FixtureCurrent {
  return {
    id: 'fx-demo',
    meta: {} as any,
    run: {} as any,
    endedWith: 'done',
    qualityStatus: 'done',
    qualityReasons: [],
    promptContexts: 3,
    promptTokens: { nvidia: 1000, nvidiaCompact: 500, gemini: 800 },
    parserOutcomes: [],
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<FixtureBaseline> = {}): FixtureBaseline {
  return {
    endedWith: 'done',
    qualityStatus: 'done',
    promptContexts: 3,
    promptTokens: { nvidia: 1000, nvidiaCompact: 500, gemini: 800 },
    parserOutcomes: [],
    ...overrides,
  };
}

describe('severityMax / driftPercent', () => {
  it('orders severities pass < warn < fail', () => {
    expect(severityMax('pass', 'warn')).toBe('warn');
    expect(severityMax('fail', 'warn')).toBe('fail');
    expect(severityMax('pass', 'pass')).toBe('pass');
  });

  it('computes symmetric percent drift against the baseline', () => {
    expect(driftPercent(110, 100)).toBeCloseTo(10);
    expect(driftPercent(90, 100)).toBeCloseTo(10);
    expect(driftPercent(0, 0)).toBe(0);
    expect(driftPercent(5, 0)).toBe(100);
  });
});

describe('compareParserOutcomes', () => {
  it('passes when outcomes are identical', () => {
    const { severity, notes } = compareParserOutcomes(['parse_fail'], ['parse_fail']);
    expect(severity).toBe('pass');
    expect(notes).toEqual([]);
  });

  it('marks fail→ok transitions as improved (warn, not regression)', () => {
    const { severity, notes } = compareParserOutcomes(['parse_ok'], ['parse_fail']);
    expect(severity).toBe('warn');
    expect(notes[0]).toContain('improved');
  });

  it('fails on ok→fail regressions', () => {
    const { severity, notes } = compareParserOutcomes(['parse_fail'], ['parse_ok']);
    expect(severity).toBe('fail');
    expect(notes[0]).toContain('回归');
  });

  it('fails when the corpus length changed', () => {
    const { severity } = compareParserOutcomes(['parse_ok'], []);
    expect(severity).toBe('fail');
  });
});

describe('evaluateFixtureAgainstBaseline', () => {
  it('warns for fixtures missing from the baseline', () => {
    const verdict = evaluateFixtureAgainstBaseline(makeCurrent(), null, THRESHOLDS);
    expect(verdict.severity).toBe('warn');
    expect(verdict.notes[0]).toContain('--update-baseline');
  });

  it('passes when everything matches', () => {
    const verdict = evaluateFixtureAgainstBaseline(makeCurrent(), makeBaseline(), THRESHOLDS);
    expect(verdict.severity).toBe('pass');
    expect(verdict.notes).toEqual([]);
    expect(verdict.drift.nvidia).toBe(0);
  });

  it('fails when the re-scored quality status changed', () => {
    const verdict = evaluateFixtureAgainstBaseline(
      makeCurrent({ qualityStatus: 'done_degraded', qualityReasons: ['有失败步骤'] }),
      makeBaseline(),
      THRESHOLDS,
    );
    expect(verdict.severity).toBe('fail');
    expect(verdict.notes.some(note => note.includes('质量重打分变化'))).toBe(true);
  });

  it('fails when endedWith changed (reconstruction drift)', () => {
    const verdict = evaluateFixtureAgainstBaseline(makeCurrent({ endedWith: 'error' }), makeBaseline(), THRESHOLDS);
    expect(verdict.severity).toBe('fail');
  });

  it('warns between warn and fail drift thresholds, fails beyond', () => {
    const warned = evaluateFixtureAgainstBaseline(
      makeCurrent({ promptTokens: { nvidia: 1150, nvidiaCompact: 500, gemini: 800 } }),
      makeBaseline(),
      THRESHOLDS,
    );
    expect(warned.severity).toBe('warn');
    expect(warned.drift.nvidia).toBeCloseTo(15);

    const failed = evaluateFixtureAgainstBaseline(
      makeCurrent({ promptTokens: { nvidia: 1300, nvidiaCompact: 500, gemini: 800 } }),
      makeBaseline(),
      THRESHOLDS,
    );
    expect(failed.severity).toBe('fail');
  });

  it('fails when the number of prompt contexts changed', () => {
    const verdict = evaluateFixtureAgainstBaseline(makeCurrent({ promptContexts: 4 }), makeBaseline(), THRESHOLDS);
    expect(verdict.severity).toBe('fail');
    expect(verdict.notes.some(note => note.includes('构建点数量'))).toBe(true);
  });
});

describe('replayParserCorpus', () => {
  it('classifies a valid decision as parse_ok', () => {
    const raw = JSON.stringify({
      rationale: '搜索',
      action: { tool: 'search', type: 'web_search', query: '天气', maxResults: 5 },
    });
    expect(replayParserCorpus([{ model: 'nvidia/test', rawOutput: raw }])).toEqual(['parse_ok']);
  });

  it('classifies truncated JSON as parse_fail', () => {
    const raw = '{"rationale":"r","action":{"tool":"core","type":"finish"';
    expect(replayParserCorpus([{ rawOutput: raw }])).toEqual(['parse_fail']);
  });

  it('classifies parseable-but-invalid actions as normalize_fail', () => {
    const raw = JSON.stringify({ rationale: 'r', action: { tool: 'no-such-tool', type: 'nope' } });
    const [outcome] = replayParserCorpus([{ rawOutput: raw }]);
    expect(['normalize_fail', 'parse_fail']).toContain(outcome);
    expect(outcome).not.toBe('parse_ok');
  });
});
