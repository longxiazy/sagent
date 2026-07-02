import { describe, expect, it, vi } from 'vitest';
import { runAgentRuntime } from '../agent/core/runtime.ts';

function visionDecision(question: string) {
  return {
    rationale: '',
    action: {
      tool: 'vision',
      type: 'image_analyze',
      image: '/tmp/example.png',
      question,
    },
  };
}

describe('runtime vision loop guard', () => {
  it('stops before repeatedly analyzing the same image a third time', async () => {
    const decide = vi.fn()
      .mockResolvedValueOnce(visionDecision('这是什么图？'))
      .mockResolvedValueOnce(visionDecision('请再仔细看这是什么图？'))
      .mockResolvedValueOnce(visionDecision('请继续识别这是什么图？'));
    const execute = vi.fn()
      .mockResolvedValueOnce('image_analyze 结果（model=test）:\n像是游戏截图。')
      .mockResolvedValueOnce('image_analyze 结果（model=test）:\n可能是某款暗黑风游戏。');

    const result = await runAgentRuntime({
      task: '这个是什么图\n\n[附件]\n- 图片: /tmp/example.png(请用 image_analyze 工具分析)',
      maxSteps: 5,
      cancelSignal: null,
      initialize: vi.fn(async () => ({})),
      observe: vi.fn(async () => ({ title: 'Desktop' })),
      decide,
      authorize: null,
      execute,
      cleanup: vi.fn(),
      onEvent: vi.fn(),
    });

    expect(decide).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(2);
    expect(result.answer).toContain('已连续 2 次对同一张图片调用 image_analyze');
    expect(result.answer).toContain('已有识图结果只能作为低置信线索');
  });
});
