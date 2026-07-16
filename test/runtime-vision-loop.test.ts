import { describe, expect, it, vi } from 'vitest';
import {
  bindVisionActionToTaskAttachment,
  extractTaskImageAttachmentPaths,
  runAgentRuntime,
} from '../agent/core/runtime.ts';

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

describe('runtime vision attachment binding', () => {
  const firstImage = '@uploads/2026-07-16/1784166951154-c48f2c-image (1).png';
  const secondImage = '@uploads/2026-07-16/1784166951155-a1b2c3-second.png';

  it('extracts original image paths from generated attachment lines', () => {
    const task = [
      '分析图片',
      '',
      '[附件]',
      `- 图片: ${firstImage}(请用 image_analyze 工具分析)`,
      `- 图片: ${secondImage}(请用 image_analyze 工具分析)`,
    ].join('\n');

    expect(extractTaskImageAttachmentPaths(task)).toEqual([firstImage, secondImage]);
  });

  it('binds @attachment/N to the original task path', () => {
    const task = [
      '[附件]',
      `- 图片: ${firstImage}(请用 image_analyze 工具分析)`,
      `- 图片: ${secondImage}(请用 image_analyze 工具分析)`,
    ].join('\n');

    const action = bindVisionActionToTaskAttachment(task, {
      tool: 'vision',
      type: 'image_analyze',
      image: '@attachment/2',
      question: '分析第二张图片',
    });

    expect(action).toMatchObject({ image: secondImage });
  });

  it('binds the attachment reference before execution', async () => {
    const execute = vi.fn().mockResolvedValue('读取成功');
    const task = `分析图\n\n[附件]\n- 图片: ${firstImage}(请用 image_analyze 工具分析)`;

    const result = await runAgentRuntime({
      task,
      maxSteps: 1,
      cancelSignal: null,
      initialize: vi.fn(async () => ({})),
      observe: vi.fn(async () => ({ title: 'Desktop' })),
      decide: vi.fn(async () => ({
        rationale: '分析附件',
        action: {
          tool: 'vision' as const,
          type: 'image_analyze' as const,
          image: '@attachment/1',
          question: '图片里有什么？',
        },
      })),
      authorize: null,
      execute,
      cleanup: vi.fn(),
      onEvent: vi.fn(),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ image: firstImage }),
      expect.anything(),
    );
    expect(result.steps[0].action).toMatchObject({ image: firstImage });
  });

  it('does not guess or repair legacy upload paths', () => {
    const task = `分析图\n\n[附件]\n- 图片: ${firstImage}(请用 image_analyze 工具分析)`;
    const legacyPath = firstImage.slice(1);
    const action = {
      tool: 'vision' as const,
      type: 'image_analyze' as const,
      image: legacyPath,
      question: '图片里有什么？',
    };

    expect(bindVisionActionToTaskAttachment(task, action)).toBe(action);
  });
});
