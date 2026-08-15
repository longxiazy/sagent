import { describe, expect, it } from 'vitest';
import { createModelResponseParser } from '../agent/core/nvidia-response-parsers.ts';

function wrap(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: null,
  };
}

function wrapWithReasoning(content: string, reasoningContent: string) {
  return {
    choices: [{ message: { content, reasoning_content: reasoningContent } }],
    usage: null,
  };
}

function wrapToolCall(name: string, args: unknown, content = '') {
  return {
    choices: [{ message: { content, tool_calls: [{ function: { name, arguments: args } }] } }],
    usage: null,
  };
}

describe('nvidia response parsers: tryToolCalls guard', () => {
  it('falls through to parseFailed instead of throwing on malformed tool_call arguments', () => {
    const parse = createModelResponseParser('qwen/qwen3.5-397b-a17b');
    // 模型把 shell 命令里的双引号原样吐出来，arguments 不是合法 JSON。
    const raw = '{"command":"echo "---""}';

    const result = parse(wrapToolCall('run_safe', raw));

    expect(result.parseFailed).toBe(true);
    // 原文必须留下来：错误信息和解析失败语料都靠它。
    expect(result.rawContent).toBe(raw);
  });

  it('keeps content as raw output when the message also carries text', () => {
    const parse = createModelResponseParser('qwen/qwen3.5-397b-a17b');
    const result = parse(wrapToolCall('run_safe', '{"command":"echo "', '短文本'));

    expect(result.parseFailed).toBe(true);
    expect(result.rawContent).toBe('短文本');
  });

  it('lets a valid JSON action in content win when tool_call arguments are broken', () => {
    const parse = createModelResponseParser('qwen/qwen3.5-397b-a17b');
    const content = JSON.stringify({ rationale: '收尾', action: { type: 'finish', answer: '完成' } });

    const result = parse(wrapToolCall('run_safe', '{"command":"echo "', content));

    expect(result.parseFailed).toBeUndefined();
    expect(result.action?.type).toBe('finish');
  });

  it('still parses well-formed tool_call arguments', () => {
    const parse = createModelResponseParser('qwen/qwen3.5-397b-a17b');
    const result = parse(wrapToolCall('finish', JSON.stringify({ answer: 'ok' })));

    expect(result.action?.type).toBe('finish');
    expect(result.action?.answer).toBe('ok');
  });

  it('skips tool_calls without a function name', () => {
    const parse = createModelResponseParser('qwen/qwen3.5-397b-a17b');
    const result = parse({
      choices: [{ message: { content: '', tool_calls: [{ function: { arguments: '{}' } }] } }],
      usage: null,
    });

    expect(result.parseFailed).toBe(true);
  });
});

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

  it('preserves reasoning_content for default parser models', () => {
    const parse = createModelResponseParser('deepseek-reasoner');
    const result = parse(wrapWithReasoning(
      JSON.stringify({ rationale: '继续执行', action: { type: 'finish', answer: '完成' } }),
      '先判断下一步'
    ));

    expect(result?.reasoning).toBe('先判断下一步');
    expect(result?.action?.type).toBe('finish');
  });
});
