import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createApiAuth,
  createCorsOptions,
  createOriginGuard,
  loadServerSecurityConfig,
} from '../helpers/security.ts';

function createApp(env: NodeJS.ProcessEnv) {
  const config = loadServerSecurityConfig(env);
  const app = express();
  app.use(createOriginGuard(config));
  app.use(cors(createCorsOptions(config)));
  app.use(createApiAuth(config));
  app.use(express.json());
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.get('/screenshots/example.png', (_req, res) => res.type('png').send('image'));
  app.get('/', (_req, res) => res.send('public'));
  return app;
}

describe('server security', () => {
  it('defaults to loopback without requiring a token', async () => {
    const config = loadServerSecurityConfig({});
    expect(config.host).toBe('127.0.0.1');
    const res = await request(createApp({})).get('/api/ping');
    expect(res.status).toBe(200);
  });

  it('refuses an external listen address without a strong token', () => {
    expect(() => loadServerSecurityConfig({ HOST: '0.0.0.0' })).toThrow('必须配置 SAGENT_API_TOKEN');
    expect(() => loadServerSecurityConfig({ HOST: '0.0.0.0', SAGENT_API_TOKEN: 'short' })).toThrow('至少需要 16 个字符');
  });

  it('protects API routes and establishes an HttpOnly session cookie', async () => {
    const app = createApp({ HOST: '0.0.0.0', SAGENT_API_TOKEN: '0123456789abcdef' });
    expect((await request(app).get('/api/ping')).status).toBe(401);

    const authenticated = await request(app)
      .get('/api/ping')
      .set('Authorization', 'Bearer 0123456789abcdef');
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers['set-cookie']?.[0]).toContain('sagent_session=');
    expect(authenticated.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(authenticated.headers['set-cookie']?.[0]).toContain('SameSite=Strict');

    const cookie = authenticated.headers['set-cookie'][0].split(';')[0];
    const screenshot = await request(app).get('/screenshots/example.png').set('Cookie', cookie);
    expect(screenshot.status).toBe(200);
  });

  it('leaves the static UI public when API auth is enabled', async () => {
    const app = createApp({ HOST: '0.0.0.0', SAGENT_API_TOKEN: '0123456789abcdef' });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe('public');
  });

  it('actively rejects disallowed origins before route handlers run', async () => {
    const app = createApp({ HOST: '127.0.0.1' });
    const denied = await request(app)
      .post('/api/ping')
      .set('Origin', 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ORIGIN_FORBIDDEN');

    const spoofedProxyHost = await request(app)
      .get('/api/ping')
      .set('Host', '127.0.0.1:3001')
      .set('X-Forwarded-Host', 'evil.example')
      .set('Origin', 'http://evil.example');
    expect(spoofedProxyHost.status).toBe(403);

    const sameOrigin = await request(app)
      .get('/api/ping')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', 'http://localhost:5173');
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('allows explicitly configured cross-origin clients and unauthenticated preflight', async () => {
    const app = createApp({
      HOST: '0.0.0.0',
      SAGENT_API_TOKEN: '0123456789abcdef',
      SAGENT_CORS_ORIGINS: 'https://ui.example',
    });
    const preflight = await request(app)
      .options('/api/ping')
      .set('Origin', 'https://ui.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'X-Sagent-Token');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://ui.example');
    expect(preflight.headers['access-control-allow-headers']).toContain('X-Sagent-Token');
  });
});
