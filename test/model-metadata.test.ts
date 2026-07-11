import { describe, expect, it, vi } from 'vitest';
import { extractModelMetadata } from '../agent/core/providers/model-metadata.ts';
import { getNvidiaCatalogModelMetadata, hasNvidiaCatalogModel } from '../agent/core/providers/nvidia-catalog.ts';
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
    })).toEqual({
      contextWindow: 131_072,
      maxOutputTokens: 16_384,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      supportedMessageRoles: ['system', 'user', 'assistant'],
      supportedParameters: ['tools', 'response_format'],
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
      contextWindow: 1_000_000,
      inputModalities: ['text'],
      outputModalities: ['text'],
    });
    expect(getNvidiaCatalogModelMetadata('meta/llama-3.1-70b-instruct')).toMatchObject({
      label: 'llama-3.1-70b-instruct',
      publisher: 'meta',
    });
    expect(hasNvidiaCatalogModel('meta/llama-3.1-70b-instruct')).toBe(true);
    expect(hasNvidiaCatalogModel('moonshotai/kimi-k2.6')).toBe(false);
  });

  it('only exposes official NVIDIA API models still present in the public catalog', async () => {
    const provider = createOpenAICompatProvider({
      chat: { completions: { create: vi.fn() } },
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'deepseek-ai/deepseek-v4-pro' },
            { id: 'moonshotai/kimi-k2.6' },
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
      contextWindow: 1_000_000,
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
});
