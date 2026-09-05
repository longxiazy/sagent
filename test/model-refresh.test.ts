import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createModelRefresher } from '../agent/core/providers/model-refresh.ts';
import { createCompletionsRouter } from '../routes/completions.ts';

function makeRegistry(fetchModels: any) {
  return { fetchModels, resolve: vi.fn(), providers: [], loadModelConfig: vi.fn() } as any;
}

// ModelInfo 要求 label，这里统一按 id 兜底，免得每个用例都写一遍。
function model(id: string, provider = 'nvidia') {
  return { id, label: id, provider };
}

function makeApp(modelConfig: any[], fetchModels: any) {
  const registry = makeRegistry(fetchModels);
  const app = express();
  app.use(express.json());
  app.use(createCompletionsRouter({
    registry,
    modelConfig,
    modelRefresher: createModelRefresher({ registry, modelConfig, refreshedAt: '2026-01-01T00:00:00.000Z' }),
  }));
  return app;
}

describe('createModelRefresher', () => {
  it('全量替换但保持数组引用，让 agent runner 等持有者立刻看到新表', async () => {
    const modelConfig = [model('old-a'), model('old-b', 'gemini')];
    const held = modelConfig; // 模拟按引用持有 modelConfig 的下游
    const refresher = createModelRefresher({
      registry: makeRegistry(vi.fn().mockResolvedValue({
        models: [model('new-a')],
        failures: [],
      })),
      modelConfig,
      now: () => '2026-08-23T12:04:00.000Z',
    });

    const status = await refresher.refresh();

    expect(held).toBe(modelConfig);
    expect(held.map(m => m.id)).toEqual(['new-a']);
    expect(status).toMatchObject({ refreshedAt: '2026-08-23T12:04:00.000Z', count: 1 });
  });

  it('报告相对刷新前的增删，供界面说清「变了什么」', async () => {
    const modelConfig = [model('keep'), model('gone', 'gemini')];
    const refresher = createModelRefresher({
      registry: makeRegistry(vi.fn().mockResolvedValue({
        models: [model('keep'), model('fresh')],
        failures: [],
      })),
      modelConfig,
    });

    const result = await refresher.refresh();

    expect(result.added).toEqual(['fresh']);
    expect(result.removed).toEqual(['gone']);
    expect(result.count).toBe(2);
  });

  it('拉到了但供应商没增删时，added/removed 为空而非报错', async () => {
    const modelConfig = [model('a'), model('b')];
    const refresher = createModelRefresher({
      registry: makeRegistry(vi.fn().mockResolvedValue({
        models: [model('a'), model('b')],
        failures: [],
      })),
      modelConfig,
    });

    const result = await refresher.refresh();

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.count).toBe(2);
  });

  it('任一供应商失败即整体放弃，现有列表一个都不动', async () => {
    const modelConfig = [model('old-a')];
    const refresher = createModelRefresher({
      registry: makeRegistry(vi.fn().mockResolvedValue({
        models: [model('new-a')],
        failures: ['gemini: fetch timeout'],
      })),
      modelConfig,
      refreshedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(refresher.refresh()).rejects.toThrow(/gemini: fetch timeout/);
    expect(modelConfig.map(m => m.id)).toEqual(['old-a']);
    // 拉取时刻也不能前进：这份列表确实还是旧的那份。
    expect(refresher.status()).toEqual({ refreshedAt: '2026-01-01T00:00:00.000Z', count: 1 });
  });

  it('并发刷新只打一次供应商接口', async () => {
    const fetchModels = vi.fn().mockResolvedValue({ models: [model('a')], failures: [] });
    const refresher = createModelRefresher({ registry: makeRegistry(fetchModels), modelConfig: [] });

    await Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh()]);

    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('失败后允许重试（in-flight 不被污染）', async () => {
    const fetchModels = vi.fn()
      .mockResolvedValueOnce({ models: [], failures: ['nvidia: 500'] })
      .mockResolvedValueOnce({ models: [model('a')], failures: [] });
    const modelConfig: any[] = [];
    const refresher = createModelRefresher({ registry: makeRegistry(fetchModels), modelConfig });

    await expect(refresher.refresh()).rejects.toThrow(/nvidia: 500/);
    await expect(refresher.refresh()).resolves.toMatchObject({ count: 1 });
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/models/refresh', () => {
  it('成功时返回新列表与拉取时刻', async () => {
    const modelConfig = [model('old-a')];
    const app = makeApp(modelConfig, vi.fn().mockResolvedValue({
      models: [model('new-a'), model('new-b', 'gemini')],
      failures: [],
    }));

    const res = await request(app).post('/api/models/refresh');

    expect(res.status).toBe(200);
    expect(res.body.models.map((m: any) => m.id)).toEqual(['new-a', 'new-b']);
    expect(res.body.count).toBe(2);
    expect(res.body.added).toEqual(['new-a', 'new-b']);
    expect(res.body.removed).toEqual(['old-a']);
    expect(res.body.refreshedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('部分供应商失败时返回 502，且 GET /api/models 仍是旧列表', async () => {
    const modelConfig = [model('old-a')];
    const app = makeApp(modelConfig, vi.fn().mockResolvedValue({
      models: [model('new-a')],
      failures: ['gemini: fetch timeout'],
    }));

    const res = await request(app).post('/api/models/refresh');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/gemini: fetch timeout/);

    const after = await request(app).get('/api/models');
    expect(after.body.models.map((m: any) => m.id)).toEqual(['old-a']);
    expect(after.body.refreshedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('供应商整体抛错时返回 502 而不是让进程崩掉', async () => {
    const modelConfig = [model('old-a')];
    const app = makeApp(modelConfig, vi.fn().mockRejectedValue(new Error('network down')));

    const res = await request(app).post('/api/models/refresh');

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/network down/);
    expect(modelConfig.map(m => m.id)).toEqual(['old-a']);
  });
});

describe('GET /api/models', () => {
  it('带上 refreshedAt / count 供设置页展示', async () => {
    const app = makeApp([model('a')], vi.fn());

    const res = await request(app).get('/api/models');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refreshedAt: '2026-01-01T00:00:00.000Z', count: 1 });
    expect(res.body.models.map((m: any) => m.id)).toEqual(['a']);
  });
});
