import crypto from 'node:crypto';
import net from 'node:net';
import type { CorsOptions } from 'cors';
import type { NextFunction, Request, Response } from 'express';

const MIN_API_TOKEN_LENGTH = 16;
const SESSION_COOKIE = 'sagent_session';

export interface ServerSecurityConfig {
  host: string;
  apiToken: string;
  allowedOrigins: Set<string>;
}

function normalizeOrigin(value: string) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`不支持的 CORS Origin: ${value}`);
  }
  return parsed.origin;
}

function hostnameOnly(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  if (net.isIP(trimmed)) return trimmed;
  return trimmed.split(':')[0];
}

export function isLoopbackHost(value: string) {
  const host = hostnameOnly(value);
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || host.startsWith('127.')
    || host.startsWith('::ffff:127.');
}

export function loadServerSecurityConfig(env: NodeJS.ProcessEnv = process.env): ServerSecurityConfig {
  const host = String(env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  const apiToken = String(env.SAGENT_API_TOKEN || '').trim();
  if (apiToken && apiToken.length < MIN_API_TOKEN_LENGTH) {
    throw new Error(`SAGENT_API_TOKEN 至少需要 ${MIN_API_TOKEN_LENGTH} 个字符`);
  }
  if (!isLoopbackHost(host) && !apiToken) {
    throw new Error(`HOST=${host} 会对外监听，必须配置 SAGENT_API_TOKEN（至少 ${MIN_API_TOKEN_LENGTH} 个字符）`);
  }

  const allowedOrigins = new Set<string>();
  for (const value of String(env.SAGENT_CORS_ORIGINS || '').split(',')) {
    const origin = value.trim();
    if (origin) allowedOrigins.add(normalizeOrigin(origin));
  }
  return { host, apiToken, allowedOrigins };
}

function requestOrigin(req: Request) {
  const protocol = req.protocol;
  const host = req.get('host');
  return host ? `${protocol}://${host}` : '';
}

export function isAllowedRequestOrigin(req: Request, origin: string, config: ServerSecurityConfig) {
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return false;
  }
  if (config.allowedOrigins.has(normalized)) return true;
  try {
    if (normalized === normalizeOrigin(requestOrigin(req))) return true;
  } catch {
    return false;
  }

  try {
    const originUrl = new URL(normalized);
    const requestUrl = new URL(requestOrigin(req));
    return isLoopbackHost(originUrl.hostname) && isLoopbackHost(requestUrl.hostname);
  } catch {
    return false;
  }
}

export function createOriginGuard(config: ServerSecurityConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (!origin || isAllowedRequestOrigin(req, origin, config)) return next();
    return res.status(403).json({ error: 'Origin 不被允许', code: 'ORIGIN_FORBIDDEN' });
  };
}

export function createCorsOptions(config: ServerSecurityConfig): CorsOptions {
  void config;
  return {
    origin(origin, callback) {
      // 实际拒绝由 origin guard 完成；这里仅控制响应头。
      callback(null, origin || false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Lang', 'X-Sagent-Token'],
    maxAge: 600,
  };
}

function isProtectedPath(pathname: string) {
  return pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/v1'
    || pathname.startsWith('/v1/')
    || pathname === '/screenshots'
    || pathname.startsWith('/screenshots/');
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sessionValue(apiToken: string) {
  return crypto.createHmac('sha256', apiToken).update('sagent-session-v1').digest('base64url');
}

function cookieValue(req: Request, name: string) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return '';
}

function requestTokens(req: Request) {
  const tokens: string[] = [];
  const authorization = req.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) tokens.push(bearer[1].trim());
  const customHeader = req.get('x-sagent-token');
  if (customHeader) tokens.push(customHeader.trim());
  return tokens;
}

export function createApiAuth(config: ServerSecurityConfig) {
  const expectedSession = config.apiToken ? sessionValue(config.apiToken) : '';

  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.apiToken || req.method === 'OPTIONS' || !isProtectedPath(req.path)) return next();

    const validHeader = requestTokens(req).some(token => safeEqual(token, config.apiToken));
    const validCookie = safeEqual(cookieValue(req, SESSION_COOKIE), expectedSession);
    if (!validHeader && !validCookie) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(401).json({ error: '需要有效的 Sagent API Token', code: 'AUTH_REQUIRED' });
    }

    if (validHeader) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const secure = req.secure || forwardedProto === 'https' || String(req.get('origin') || '').startsWith('https://');
      res.cookie(SESSION_COOKIE, expectedSession, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
      });
    }
    return next();
  };
}
