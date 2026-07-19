import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectToolsOverride, resolveToolModel } from '../agent/core/tool-model-resolver.ts';

describe('resolveToolModel', () => {
  const globalTools = { vision: { model: 'global/vision' }, distill: { model: 'global/distill' } };

  it('项目 override 最高优先', () => {
    const model = resolveToolModel('distill', {
      projectTools: { distill: { model: 'proj/distill' } },
      globalTools,
      envModel: 'env/distill',
      mainModel: 'main/model',
    });
    expect(model).toBe('proj/distill');
  });

  it('项目未设 → 全局', () => {
    expect(resolveToolModel('distill', { projectTools: {}, globalTools, envModel: 'env/x', mainModel: 'main/m' }))
      .toBe('global/distill');
  });

  it('项目/全局未设 → env', () => {
    expect(resolveToolModel('distill', { projectTools: {}, globalTools: {}, envModel: 'env/distill', mainModel: 'main/m' }))
      .toBe('env/distill');
  });

  it('全部未设 → 主模型', () => {
    expect(resolveToolModel('vision', { projectTools: {}, globalTools: {}, envModel: '', mainModel: 'main/model' }))
      .toBe('main/model');
  });

  it('空白值被跳过', () => {
    expect(resolveToolModel('vision', {
      projectTools: { vision: { model: '   ' } },
      globalTools: { vision: { model: '' } },
      envModel: '  ',
      mainModel: 'main/model',
    })).toBe('main/model');
  });

  it('vision 与 distill 相互独立', () => {
    const args = { projectTools: { vision: { model: 'proj/vision' } }, globalTools, mainModel: 'main/m' };
    expect(resolveToolModel('vision', args)).toBe('proj/vision');
    expect(resolveToolModel('distill', args)).toBe('global/distill');
  });
});

describe('readProjectToolsOverride', () => {
  async function tempDataDir(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tmr-'));
    if (config !== undefined) await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
    return dir;
  }

  it('读取 tools.vision/distill.model', async () => {
    const dir = await tempDataDir({ tools: { vision: { model: 'v/m' }, distill: { model: 'd/m' } } });
    expect(await readProjectToolsOverride(dir)).toEqual({ vision: { model: 'v/m' }, distill: { model: 'd/m' } });
  });

  it('无 dataDir → 空', async () => {
    expect(await readProjectToolsOverride(null)).toEqual({});
    expect(await readProjectToolsOverride(undefined)).toEqual({});
  });

  it('无 config.json → 空', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmr-'));
    expect(await readProjectToolsOverride(dir)).toEqual({});
  });

  it('坏 JSON → 空', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmr-'));
    await writeFile(join(dir, 'config.json'), '{bad json', 'utf-8');
    expect(await readProjectToolsOverride(dir)).toEqual({});
  });

  it('无 tools 段 → 空', async () => {
    const dir = await tempDataDir({ version: 1, agent: {} });
    expect(await readProjectToolsOverride(dir)).toEqual({});
  });

  it('只设了一个工具时只返回该工具', async () => {
    const dir = await tempDataDir({ tools: { distill: { model: 'd/m' } } });
    expect(await readProjectToolsOverride(dir)).toEqual({ distill: { model: 'd/m' } });
  });
});
