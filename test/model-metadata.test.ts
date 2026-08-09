import { describe, expect, it, vi } from 'vitest';
import { extractModelMetadata } from '../agent/core/providers/model-metadata.ts';
import { getNvidiaCatalogModelMetadata, hasNvidiaCatalogModel } from '../agent/core/providers/nvidia-catalog.ts';
import { getGeminiCatalogModelMetadata } from '../agent/core/providers/gemini-catalog.ts';
import { createGeminiProvider } from '../agent/core/providers/gemini.ts';
import { createOpenAICompatProvider } from '../agent/core/providers/openai-compat.ts';

async function* asyncItems(items: any[]) {
  for (const item of items) yield item;
}

describe('model metadata', () => {
  it('extracts common OpenAI-compatible model metadata', () => {
    expect(extractModelMetadata({
      context_length: 131_072,
      max_completion_tokens: 16_384,
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        modality: 'text+image->text',
      },
      supported_parameters: ['tools', 'response_format'],
      supported_message_roles: ['system', 'user', 'assistant'],
      pricing: { input: 0, output: 2 },
      time_to_first_token_ms: 240,
      quality_score: 91,
    })).toEqual({
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedMessageRoles: ['system', 'user', 'assistant'],
      supportedParameters: ['tools', 'response_format'],
      inputPricePerMillionTokens: 0,
      outputPricePerMillionTokens: 2,
      latencyMs: 240,
      qualityScore: 91,
    });
  });

  it('preserves metadata returned by OpenAI-compatible model listing', async () => {
    const provider = createOpenAICompatProvider({
      chat: { completions: { create: vi.fn() } },
      models: {
        list: vi.fn().mockResolvedValue({
          data: [{
            id: 'meta/llama-3.1-8b-instruct',
            context_length: 128_000,
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            supported_parameters: ['tools'],
          }],
        }),
      },
    });

    // 本地目录已不含 label，label 回退到 API 返回的原始 id。
    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({
      id: 'meta/llama-3.1-8b-instruct',
      label: 'meta/llama-3.1-8b-instruct',
      provider: 'nvidia',
      contextWindow: 128_000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['tools'],
    })]);
  });

  it('merges greeting scores and local overrides by id and aliases', () => {
    // config/model-catalog/nvidia.json 已清空（models: {}），`/v1/models` 是可用模型的
    // 唯一来源。getNvidiaCatalogModelMetadata 现在只剩 greeting-scores 与 overrides
    // 两个数据源，不再提供 label/contextWindow/modalities 这类目录快照字段。
    expect(getNvidiaCatalogModelMetadata('deepseek-ai/deepseek-v4-pro')).toEqual({
      greetingScore: 100,
      greetingAverageLatencyMs: 44_199,
      greetingSuccesses: 3,
    });
    // 别名归一化：下划线转点、大小写不敏感。
    expect(getNvidiaCatalogModelMetadata('META/LLAMA-3.1-70B-INSTRUCT')).toMatchObject({
      greetingScore: 100,
      greetingSuccesses: 3,
    });
    expect(getNvidiaCatalogModelMetadata('upstage/solar-10.7b-instruct')).toEqual({
      agentCompatible: false,
    });
    // 目录已空，任何 id 都不再命中 catalog 允许清单。
    expect(hasNvidiaCatalogModel('meta/llama-3.1-70b-instruct')).toBe(false);
    expect(hasNvidiaCatalogModel('example/delisted-model-not-in-catalog')).toBe(false);
  });

  it('keeps zero greeting scores as measured values', () => {
    expect(getNvidiaCatalogModelMetadata('meta/llama-3.2-3b-instruct')).toMatchObject({
      greetingScore: 0,
      greetingSuccesses: 0,
    });
  });

  it('only exposes message roles backed by a local verified override', () => {
    expect(getNvidiaCatalogModelMetadata('google/gemma-2-2b-it')).toMatchObject({
      agentCompatible: false,
      supportedMessageRoles: ['user', 'assistant'],
    });
    expect(getNvidiaCatalogModelMetadata('deepseek-ai/deepseek-v4-pro')).not.toHaveProperty('supportedMessageRoles');
  });

  it('removes unavailable hosted generation methods from locally verified NVIDIA models', () => {
    expect(getNvidiaCatalogModelMetadata('nvidia/cosmos-reason2-8b')).toMatchObject({
      agentCompatible: false,
      supportedGenerationMethods: [],
    });
  });

  it('loads Gemini free-tier and Agent compatibility overrides', () => {
    expect(getGeminiCatalogModelMetadata('gemini-3.1-pro-preview')).toMatchObject({
      agentCompatible: false,
    });
    expect(getGeminiCatalogModelMetadata('GEMINI-3-PRO-PREVIEW')).toMatchObject({
      agentCompatible: false,
    });
    expect(getGeminiCatalogModelMetadata('gemini-2.5-flash')).toEqual({});
  });

  it('exposes NVIDIA API models even when they are absent from the local catalog', async () => {
    const provider = createOpenAICompatProvider({
      chat: { completions: { create: vi.fn() } },
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'deepseek-ai/deepseek-v4-pro' },
            // 本地 catalog 只是元数据快照，不能过滤 NVIDIA API 实际返回的模型。
            // 使用合成 id，避免测试随 catalog 刷新而失效。
            { id: 'example/delisted-model-not-in-catalog' },
          ],
        }),
      },
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'deepseek-ai/deepseek-v4-pro' }),
      expect.objectContaining({
        id: 'example/delisted-model-not-in-catalog',
        label: 'example/delisted-model-not-in-catalog',
        provider: 'nvidia',
      }),
    ]);
  });

  it('does not attach NVIDIA catalog metadata to custom OpenAI-compatible endpoints', async () => {
    const provider = createOpenAICompatProvider({
      chat: { completions: { create: vi.fn() } },
      models: {
        list: vi.fn().mockResolvedValue({ data: [{ id: 'custom/chat-model' }] }),
      },
    }, { baseURL: 'https://api.example.com/v1' });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: 'custom/chat-model',
        provider: 'example',
      }),
    ]);
  });

  it('enriches NVIDIA model listings with local metadata without changing ids', async () => {
    const provider = createOpenAICompatProvider({
      chat: { completions: { create: vi.fn() } },
      models: {
        list: vi.fn().mockResolvedValue({
          data: [{
            id: 'deepseek-ai/deepseek-v4-pro',
          }],
        }),
      },
    });

    // 目录已清空，API 未返回的字段不再被补齐；只有 greeting-scores/overrides 会合并进来。
    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({
      id: 'deepseek-ai/deepseek-v4-pro',
      label: 'deepseek-ai/deepseek-v4-pro',
      provider: 'nvidia',
      greetingScore: 100,
      greetingSuccesses: 3,
    })]);
  });

  it('preserves Gemini context limits and generation methods', async () => {
    const provider = createGeminiProvider({
      models: {
        list: vi.fn().mockResolvedValue(asyncItems([{
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        }])),
      },
    } as any);

    await expect(provider.listModels()).resolves.toEqual([{
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      provider: 'gemini',
      contextWindow: 1_048_576,
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      maxOutputTokens: 65_536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    }]);
  });

  it('enriches Gemini model listings from local overrides', async () => {
    const provider = createGeminiProvider({
      models: {
        list: vi.fn().mockResolvedValue(asyncItems([{
          name: 'models/gemini-3.1-pro-preview',
          displayName: 'Gemini 3.1 Pro Preview',
          supportedGenerationMethods: ['generateContent'],
        }])),
      },
    } as any);

    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({
      id: 'gemini-3.1-pro-preview',
      provider: 'gemini',
      agentCompatible: false,
    })]);
  });
});
