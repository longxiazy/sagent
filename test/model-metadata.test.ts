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

    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({
      id: 'meta/llama-3.1-8b-instruct',
      label: 'llama-3.1-8b-instruct',
      provider: 'nvidia',
      contextWindow: 128_000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['tools'],
    })]);
  });

  it('loads static NVIDIA catalog metadata by id and aliases', () => {
    expect(getNvidiaCatalogModelMetadata('deepseek-ai/deepseek-v4-pro')).toMatchObject({
      label: 'deepseek-v4-pro',
      contextWindow: 1_048_576,
      inputModalities: ['text'],
      outputModalities: ['text'],
      greetingScore: 100,
      greetingAverageLatencyMs: 44_199,
      greetingSuccesses: 3,
    });
    expect(getNvidiaCatalogModelMetadata('meta/llama-3.1-70b-instruct')).toMatchObject({
      label: 'llama-3.1-70b-instruct',
      publisher: 'meta',
    });
    expect(getNvidiaCatalogModelMetadata('upstage/solar-10.7b-instruct')).toMatchObject({
      label: 'solar-10.7b-instruct',
      contextWindow: 4_096,
      agentCompatible: false,
    });
    expect(hasNvidiaCatalogModel('meta/llama-3.1-70b-instruct')).toBe(true);
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

  it('only exposes official NVIDIA API models still present in the public catalog', async () => {
    const provider = createOpenAICompatProvider({
      chat: { completions: { create: vi.fn() } },
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'deepseek-ai/deepseek-v4-pro' },
            // 只在 /v1/models 里存在、公开 catalog 已下线的模型不应展示。
            // 用一个不可能被上游重新收录的合成 id，避免测试随 catalog 刷新而失效。
            { id: 'example/delisted-model-not-in-catalog' },
          ],
        }),
      },
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'deepseek-ai/deepseek-v4-pro' }),
    ]);
  });

  it('does not apply the NVIDIA catalog allowlist to custom OpenAI-compatible endpoints', async () => {
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

  it('enriches NVIDIA model listings from the static catalog without changing ids', async () => {
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

    await expect(provider.listModels()).resolves.toEqual([expect.objectContaining({
      id: 'deepseek-ai/deepseek-v4-pro',
      label: 'deepseek-v4-pro',
      provider: 'nvidia',
      contextWindow: 1_048_576,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedGenerationMethods: expect.arrayContaining(['chat.completions', 'tool_calling']),
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
