import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCompletionsRouter } from '../routes/completions.ts';
import { createProviderRegistry } from '../agent/core/providers/registry.ts';

describe('GET /api/models', () => {
  it('returns model loading errors without failing the settings API surface', async () => {
    const registry: any = {
      resolve: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use(createCompletionsRouter({
      registry,
      modelConfig: [],
      modelConfigError: 'catalog unavailable',
    }));

    const res = await request(app).get('/api/models');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: [], error: 'catalog unavailable' });
  });
});

describe('provider registry startup behavior', () => {
  it('allows construction without configured providers so config routes can still start', async () => {
    const registry = createProviderRegistry({});

    await expect(registry.loadModelConfig()).rejects.toThrow('未配置任何供应商');
  });
});

describe('POST /v1/chat/completions', () => {
  it('requires an explicit model', async () => {
    const registry: any = {
      resolve: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use(createCompletionsRouter({
      registry,
      modelConfig: [{ id: 'test-model', provider: 'test' }],
    }));

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      message: 'model is required',
      type: 'invalid_request_error',
    });
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('passes chat_template_kwargs to the resolved provider', async () => {
    const completionJson = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const registry: any = {
      resolve: vi.fn().mockReturnValue({ completionJson }),
    };
    const app = express();
    app.use(express.json());
    app.use(createCompletionsRouter({
      registry,
      modelConfig: [{ id: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia' }],
    }));

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({
        model: 'deepseek-ai/deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hi' }],
        chat_template_kwargs: { thinking: true, reasoning_effort: 'high' },
      });

    expect(res.status).toBe(200);
    expect(completionJson).toHaveBeenCalledWith(expect.objectContaining({
      chat_template_kwargs: { thinking: true, reasoning_effort: 'high' },
      preserveReasoningContent: true,
    }));
  });
});
