import { Router } from 'express';
import { deriveProviderName } from '../agent/core/ai-client.ts';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';

// 只读展示用：脱敏 API Key（仅保留后 4 位，绝不回传明文）。
function maskKey(key?: string): string | null {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

// 三家供应商的 Key 状态（只读）。Key 仍在 .env 配置，前台仅展示是否已配置 + 脱敏尾号。
function describeKeys() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  return [
    {
      envVar: 'NVIDIA_API_KEY',
      provider: deriveProviderName(process.env.NVIDIA_BASE_URL),
      baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      configured: !!nvidiaKey,
      masked: maskKey(nvidiaKey),
    },
    {
      envVar: 'ANTHROPIC_API_KEY',
      provider: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      configured: !!anthropicKey,
      masked: maskKey(anthropicKey),
    },
    {
      envVar: 'GEMINI_API_KEY',
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      configured: !!geminiKey,
      masked: maskKey(geminiKey),
    },
  ];
}

export function createAgentConfigRouter({ runtimeConfig }: AgentRouterContext) {
  const router = Router();

  // 当前 Agent 行为参数 + env 默认值（供前端「恢复默认」对照）+ Key 只读状态。
  router.get('/api/config', (_req, res) => {
    res.json({
      agent: runtimeConfig.get(),
      defaults: runtimeConfig.defaults(),
      keys: describeKeys(),
    });
  });

  // 更新 Agent 行为参数；校验失败返回 400 + 原因，成功后落盘并下次任务即生效。
  router.post('/api/config', async (req, res) => {
    try {
      const agent = await runtimeConfig.update(req.body ?? {});
      res.json({ agent });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
  });

  // 清空前台覆盖，回到 .env 默认值。
  router.post('/api/config/reset', async (_req, res) => {
    const agent = await runtimeConfig.reset();
    res.json({ agent });
  });

  return router;
}
