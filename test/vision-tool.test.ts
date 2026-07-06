import { describe, expect, it, vi } from 'vitest';
import { executeVisionAction, resolveVisionModel } from '../agent/tools/vision/execute.ts';
import { createGeminiProvider } from '../agent/core/providers/gemini.ts';

const DATA_URL = 'data:image/png;base64,aGVsbG8=';

function mockRegistry(provider: any) {
  return {
    resolve: vi.fn(() => provider),
  };
}

describe('vision tool model selection', () => {
  it('uses the selected image-capable model before the configured fallback', async () => {
    const provider = {
      completionJson: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '图片里有一个界面。' } }],
      }),
    };
    const registry = mockRegistry(provider);

    const result = await executeVisionAction(
      { image: DATA_URL, question: '图里是什么？' },
      {
        registry,
        visionModel: 'meta/llama-3.2-90b-vision-instruct',
        model: 'deepseek-ai/deepseek-v4-pro',
        agentModels: ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.2-11b-vision-instruct'],
        modelConfig: [
          { id: 'deepseek-ai/deepseek-v4-pro', label: 'deepseek-v4-pro', provider: 'nvidia', inputModalities: ['text'] },
          { id: 'meta/llama-3.2-11b-vision-instruct', label: 'llama-3.2-11b-vision-instruct', provider: 'nvidia', inputModalities: ['text', 'image'] },
        ],
      }
    );

    expect(registry.resolve).toHaveBeenCalledWith('meta/llama-3.2-11b-vision-instruct', expect.any(Array));
    expect(provider.completionJson.mock.calls[0][0].model).toBe('meta/llama-3.2-11b-vision-instruct');
    expect(result).toContain('model=meta/llama-3.2-11b-vision-instruct');
  });

  it('falls back to VISION_MODEL when selected models are text-only', () => {
    expect(resolveVisionModel({
      visionModel: 'meta/llama-3.2-90b-vision-instruct',
      model: 'deepseek-ai/deepseek-v4-pro',
      agentModels: ['deepseek-ai/deepseek-v4-pro'],
      modelConfig: [
        { id: 'deepseek-ai/deepseek-v4-pro', label: 'deepseek-v4-pro', provider: 'nvidia', inputModalities: ['text'] },
      ],
    })).toEqual({
      model: 'meta/llama-3.2-90b-vision-instruct',
      source: 'fallback',
    });
  });

  it('does not use image-generation models for image analysis', () => {
    expect(resolveVisionModel({
      visionModel: 'meta/llama-3.2-90b-vision-instruct',
      model: 'qwen/qwen-image-edit',
      agentModels: ['qwen/qwen-image-edit'],
      modelConfig: [
        { id: 'qwen/qwen-image-edit', label: 'qwen-image-edit', provider: 'nvidia', inputModalities: ['text', 'image'], outputModalities: ['image'] },
      ],
    })).toEqual({
      model: 'meta/llama-3.2-90b-vision-instruct',
      source: 'fallback',
    });
  });

  it('treats Gemini chat models as selected vision candidates', () => {
    expect(resolveVisionModel({
      visionModel: 'meta/llama-3.2-90b-vision-instruct',
      model: 'gemini-2.5-flash',
      agentModels: ['gemini-2.5-flash'],
      modelConfig: [
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini' },
      ],
    })).toEqual({
      model: 'gemini-2.5-flash',
      source: 'selected',
    });
  });
});

describe('Gemini provider multimodal completion', () => {
  it('converts OpenAI-style image_url parts to Gemini inlineData parts', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: '看到了图片。',
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    });
    const provider = createGeminiProvider({
      models: { generateContent },
    } as any);

    await provider.completionJson({
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      top_p: 1,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '请看图' },
          { type: 'image_url', image_url: { url: DATA_URL } },
        ],
      }],
    });

    expect(generateContent.mock.calls[0][0].contents[0].parts).toEqual([
      { text: '请看图' },
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
    ]);
  });
});
