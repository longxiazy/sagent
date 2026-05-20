import { describe, expect, it } from 'vitest';
import { createModelResponseParser } from '../agent/core/nvidia-response-parsers.ts';

function wrap(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: null,
  };
}

describe('nvidia response parsers: tryTextFinish guard', () => {
  it('rejects broken-JSON action wrapped in ```json fences instead of treating it as finish', () => {
    const parse = createModelResponseParser('z-ai/glm-5.1');
    // Mirror of trace run_mp9adxiu step 10: LLM emits next-step action JSON
    // wrapped in markdown fences, with a missing quote that makes it invalid JSON.
    const content = [
      '```json',
      '{',
      '  "rationale": "改用 find + wc 统计文件行数",',
      '  "action": {',
      '    "tool":terminal",',
      '    "type":"run_safe",',
      '    "command":"find . -type f"',
      '  }',
      '}',
      '```',
    ].join('\n');
    const result = parse(wrap(content));
    // Should NOT be misclassified as finish — parser returns null so the planner retries
    expect(result?.action?.type).not.toBe('finish');
  });

  it('still accepts genuine substantive prose answer as finish', () => {
    const parse = createModelResponseParser('z-ai/glm-5.1');
    const content = [
      '今日杭州天气晴朗，气温区间在十八度到二十六度之间，适合户外活动。',
      '建议早晚穿着轻便外套，下午紫外线较强需要做好防晒措施。',
      '风力维持在二到三级，空气质量优良，能见度良好，适合外出踏青。',
      '若计划长时间在户外停留，请补充水分并携带遮阳伞或防晒霜。',
    ].join('\n');
    const result = parse(wrap(content));
    expect(result?.action?.type).toBe('finish');
    expect(result?.action?.answer).toContain('杭州');
  });
});
