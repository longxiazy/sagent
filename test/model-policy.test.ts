import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchesNonAgentKeyword, resolveAgentCompatible } from '../agent/core/ai-client.ts';
import { configStore } from '../agent/core/config-store.ts';
import { DEFAULT_NON_AGENT_KEYWORDS } from '../agent/core/config-schema.ts';
import { createOpenAICompatProvider } from '../agent/core/providers/openai-compat.ts';
import { createGeminiProvider } from '../agent/core/providers/gemini.ts';
import { applyModelPolicy } from '../agent/core/providers/model-policy.ts';

async function initConfig(models?: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-model-policy-'));
  if (models !== undefined) {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, models }));
  }
  await configStore.init(dir);
  return dir;
}

function mockNvidiaClient(ids: string[]) {
  return {
    models: { list: async () => ({ data: ids.map(id => ({ id })) }) },
    chat: { completions: { create: async () => ({}) } },
  };
}

function mockGeminiClient(entries: Array<{ name: string; supportedActions?: string[] }>): any {
  return {
    models: {
      list: async () => (async function* () {
        for (const entry of entries) yield entry;
      })(),
    },
  };
}

describe('non-agent keyword matching', () => {
  it('matches case-insensitively on substrings', () => {
    const keywords = ['-vision', 'embed'];
    expect(matchesNonAgentKeyword('meta/llama-3.2-11b-vision-instruct', keywords)).toBe(true);
    expect(matchesNonAgentKeyword('NV-Embed-v1', keywords)).toBe(true);
    expect(matchesNonAgentKeyword('deepseek-ai/deepseek-v3', keywords)).toBe(false);
  });

  it('treats an empty keyword list as "mark nothing"', () => {
    expect(matchesNonAgentKeyword('meta/llama-3.2-11b-vision-instruct', [])).toBe(false);
  });

  it('ignores blank keywords instead of matching everything', () => {
    // ''.includes 恒真，不挡住会把整张列表标成不可用。
    expect(matchesNonAgentKeyword('deepseek-ai/deepseek-v3', ['', '   '])).toBe(false);
  });
});

describe('agentCompatible resolution precedence', () => {
  const keywords = ['-vision'];

  it('falls back to undefined when no rule has an opinion', () => {
    expect(resolveAgentCompatible('deepseek-ai/deepseek-v3', { keywords })).toBeUndefined();
  });

  it('marks keyword hits as incompatible', () => {
    expect(resolveAgentCompatible('meta/llama-3.2-11b-vision-instruct', { keywords })).toBe(false);
  });

  it('lets catalog metadata override the keyword table', () => {
    expect(resolveAgentCompatible('meta/llama-3.2-11b-vision-instruct', { keywords, catalogValue: true })).toBe(true);
    expect(resolveAgentCompatible('deepseek-ai/deepseek-v3', { keywords, catalogValue: false })).toBe(false);
  });

  it('lets an explicit config override beat both catalog and keywords', () => {
    const overrides = { 'meta/llama-3.2-11b-vision-instruct': true };
    expect(resolveAgentCompatible('meta/llama-3.2-11b-vision-instruct', {
      keywords,
      overrides,
      catalogValue: false,
    })).toBe(true);
  });

  it('matches override ids case-insensitively', () => {
    expect(resolveAgentCompatible('Meta/Llama-3.2-11B-Vision-Instruct', {
      keywords,
      overrides: { 'meta/llama-3.2-11b-vision-instruct': true },
    })).toBe(true);
  });
});

describe('configStore.models()', () => {
  it('returns the built-in keyword table when config.json says nothing', async () => {
    await initConfig();
    expect(configStore.models().nonAgentKeywords).toEqual(DEFAULT_NON_AGENT_KEYWORDS);
    expect(configStore.models().agentCompatible).toEqual({});
  });

  it('replaces the built-in table when nonAgentKeywords is set', async () => {
    await initConfig({ nonAgentKeywords: ['embed'], agentCompatible: { 'meta/x': true } });
    expect(configStore.models().nonAgentKeywords).toEqual(['embed']);
    expect(configStore.models().agentCompatible).toEqual({ 'meta/x': true });
  });

  it('honours an empty array as "disable keyword marking" rather than "unset"', async () => {
    await initConfig({ nonAgentKeywords: [] });
    expect(configStore.models().nonAgentKeywords).toEqual([]);
  });

  it('drops non-string keywords and non-boolean override values', async () => {
    await initConfig({ nonAgentKeywords: ['embed', 42, null], agentCompatible: { 'a/b': 'yes', 'c/d': false } });
    expect(configStore.models().nonAgentKeywords).toEqual(['embed']);
    expect(configStore.models().agentCompatible).toEqual({ 'c/d': false });
  });

  it('survives a round trip through normalizeConfigDocument on save', async () => {
    // models 段没进 normalize 白名单的话，下次前台存配置就会被静默抹掉。
    const dir = await initConfig({ nonAgentKeywords: ['embed'] });
    await configStore.update({ maxSteps: 12 });
    await configStore.init(dir);
    expect(configStore.models().nonAgentKeywords).toEqual(['embed']);
  });
});

describe('applyModelPolicy idempotency', () => {
  it('clears a stale tag when the new policy has no opinion', async () => {
    await initConfig();
    // 配置热更新会对同一个数组反复调用，上一轮的结论不能残留。
    const models: any[] = [{ id: 'meta/llama-3.2-11b-vision-instruct', provider: 'nvidia' }];

    applyModelPolicy(models, { nonAgentKeywords: ['-vision'] });
    expect(models[0].agentCompatible).toBe(false);

    applyModelPolicy(models, { nonAgentKeywords: [] });
    expect('agentCompatible' in models[0]).toBe(false);
  });

  it('returns the same array reference so shared holders see the update', async () => {
    await initConfig();
    const models: any[] = [{ id: 'nvidia/nv-embed-v1', provider: 'nvidia' }];
    expect(applyModelPolicy(models, { nonAgentKeywords: ['embed'] })).toBe(models);
    expect(models[0].agentCompatible).toBe(false);
  });

  it('is stable when applied twice with the same policy', async () => {
    await initConfig();
    const models: any[] = [{ id: 'nvidia/nv-embed-v1', provider: 'nvidia' }];
    const policy = { nonAgentKeywords: ['embed'], agentCompatible: {} };
    applyModelPolicy(models, policy);
    const first = { ...models[0] };
    applyModelPolicy(models, policy);
    expect(models[0]).toEqual(first);
  });
});

describe('configStore.updateModels()', () => {
  it('replaces the keyword table and keeps the untouched field', async () => {
    await initConfig({ nonAgentKeywords: ['embed'], agentCompatible: { 'a/b': true } });
    const saved = await configStore.updateModels({ nonAgentKeywords: ['guard'] });
    expect(saved.nonAgentKeywords).toEqual(['guard']);
    expect(saved.agentCompatible).toEqual({ 'a/b': true });
  });

  it('treats null as "restore the built-in default"', async () => {
    await initConfig({ nonAgentKeywords: ['embed'] });
    const saved = await configStore.updateModels({ nonAgentKeywords: null });
    expect(saved.nonAgentKeywords).toEqual(DEFAULT_NON_AGENT_KEYWORDS);
  });

  it('keeps an explicitly empty keyword list rather than restoring defaults', async () => {
    await initConfig();
    const saved = await configStore.updateModels({ nonAgentKeywords: [] });
    expect(saved.nonAgentKeywords).toEqual([]);
  });

  it('rejects a non-array keyword list', async () => {
    await initConfig();
    await expect(configStore.updateModels({ nonAgentKeywords: 'embed' })).rejects.toThrow('nonAgentKeywords');
  });

  it('rejects a non-object patch', async () => {
    await initConfig();
    await expect(configStore.updateModels(['embed'])).rejects.toThrow('models');
  });
});

describe('provider listModels marks instead of dropping', () => {
  it('keeps NVIDIA vision models in the list and tags them', async () => {
    await initConfig();
    const provider = createOpenAICompatProvider(
      mockNvidiaClient(['meta/llama-3.2-11b-vision-instruct', 'deepseek-ai/deepseek-v3', 'nvidia/nv-embed-v1']),
      { baseURL: 'https://integrate.api.nvidia.com/v1' },
    );

    const models = await provider.listModels();

    expect(models.map(m => m.id)).toEqual([
      'meta/llama-3.2-11b-vision-instruct',
      'deepseek-ai/deepseek-v3',
      'nvidia/nv-embed-v1',
    ]);
    expect(models[0].agentCompatible).toBe(false);
    expect(models[1].agentCompatible).toBeUndefined();
    expect(models[2].agentCompatible).toBe(false);
  });

  it('applies the config override so a vision model can be used for agent decisions', async () => {
    await initConfig({ agentCompatible: { 'meta/llama-3.2-11b-vision-instruct': true } });
    const provider = createOpenAICompatProvider(
      mockNvidiaClient(['meta/llama-3.2-11b-vision-instruct']),
      { baseURL: 'https://integrate.api.nvidia.com/v1' },
    );

    const [model] = await provider.listModels();
    expect(model.agentCompatible).toBe(true);
  });

  it('marks Gemini image/tts models but still returns them', async () => {
    await initConfig();
    const provider = createGeminiProvider(mockGeminiClient([
      { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] },
      { name: 'models/imagen-3.0-generate-002', supportedActions: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
    ]));

    const models = await provider.listModels();

    // embedding 模型不支持 generateContent，是唯一保留的硬丢弃（调了必失败）。
    expect(models.map(m => m.id)).toEqual(['gemini-2.5-flash', 'imagen-3.0-generate-002']);
    expect(models[0].agentCompatible).toBeUndefined();
    expect(models[1].agentCompatible).toBe(false);
  });
});
