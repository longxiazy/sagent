import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCompletionsRouter } from '../routes/completions.ts';

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
});
