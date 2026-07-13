import { Router } from 'express';
import { deriveProviderName } from '../agent/core/ai-client.ts';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';
import { loadChromeMcpConfig } from '../agent/tools/chrome/mcp-client.ts';
import { loadIdeMcpConfig } from '../agent/tools/ide/mcp-client.ts';

// 只读展示用：脱敏 API Key（仅保留后 4 位，绝不回传明文）。
function maskKey(key?: string): string | null {
  if (!key) return null;
  return `••••${key.slice(-4)}`;
}

// 供应商 Key 状态（只读）。Key 仍在 .env 配置，前台仅展示是否已配置 + 脱敏尾号。
function describeKeys() {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
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
      envVar: 'GEMINI_API_KEY',
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      configured: !!geminiKey,
      masked: maskKey(geminiKey),
    },
  ];
}

async function testMcpConnection(name: string) {
  if (name === 'chrome') {
    const { createChromeMcpClient, loadChromeMcpConfig } = await import('../agent/tools/chrome/mcp-client.ts');
    const client = createChromeMcpClient(loadChromeMcpConfig());
    try {
      const tools = await client.listTools({ refresh: true });
      return { ok: true, toolCount: tools.length };
    } finally {
      await client.close().catch(() => {});
    }
  }
  if (name === 'jetbrains') {
    const { createIdeMcpClient, loadIdeMcpConfig } = await import('../agent/tools/ide/mcp-client.ts');
    const client = createIdeMcpClient(loadIdeMcpConfig());
    try {
      const tools = await client.listTools({ refresh: true });
      return { ok: true, toolCount: tools.length };
    } finally {
      await client.close().catch(() => {});
    }
  }
  const { createGenericMcpClient, getGenericMcpServer } = await import('../agent/tools/mcp/client.ts');
  const client = createGenericMcpClient(name, getGenericMcpServer(name));
  try {
    const tools = await client.listTools({ refresh: true });
    return { ok: true, toolCount: tools.length };
  } finally {
    await client.close().catch(() => {});
  }
}

function effectiveMcpServers(configStore: AgentRouterContext['configStore']) {
  const stored = configStore.mcpServers();
  const sources: Record<string, 'user' | 'env' | 'default'> = {};
  const servers: Record<string, any> = { ...stored };
  for (const name of Object.keys(stored)) sources[name] = 'user';

  if (!servers.chrome) {
    const chrome = loadChromeMcpConfig();
    if (chrome.enabled) {
      servers.chrome = {
        enabled: true,
        transport: { type: 'sse', url: chrome.url || `http://${chrome.host}:${chrome.port}${chrome.ssePath}` },
        promptMode: 'lazy',
        keepOpen: chrome.keepOpen,
        keepTabs: chrome.keepTabs,
        toolTimeoutMs: chrome.toolTimeoutMs,
        navigateTimeoutMs: chrome.navigateTimeoutMs,
      };
      sources.chrome = 'env';
    }
  }
  if (!servers.jetbrains) {
    const ide = loadIdeMcpConfig();
    if (ide.enabled) {
      servers.jetbrains = {
        enabled: true,
        transport: ide.transport === 'stdio'
          ? { type: 'stdio', command: ide.command, args: ide.args, cwd: ide.cwd }
          : { type: 'sse', url: ide.url || `http://${ide.host}:${ide.port}${ide.ssePath}`, ...(ide.messagesUrl ? { messagesUrl: ide.messagesUrl } : {}) },
        projectPath: ide.projectPath,
        promptMode: 'lazy',
      };
      sources.jetbrains = 'env';
    }
  }
  return { servers, sources };
}

export function createAgentConfigRouter({ configStore }: AgentRouterContext) {
  const router = Router();
  const configPayload = (agent = configStore.get()) => {
    const mcp = effectiveMcpServers(configStore);
    return {
      agent,
      defaults: configStore.defaults(),
      sources: configStore.sources(),
      schema: configStore.schema(),
      profiles: configStore.profiles(),
      profile: configStore.document().profile || 'custom',
      mcpServers: mcp.servers,
      mcpSources: mcp.sources,
    };
  };

  // 当前 Agent 行为参数 + env 默认值（供前端「恢复默认」对照）+ Key 只读状态。
  router.get('/api/config', (_req, res) => {
    res.json({ ...configPayload(), keys: describeKeys() });
  });

  // 更新 Agent 行为参数；校验失败返回 400 + 原因，成功后落盘并下次任务即生效。
  router.post('/api/config', async (req, res) => {
    try {
      const agent = await configStore.update(req.body ?? {});
      res.json(configPayload(agent));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
  });

  // 清空前台覆盖，回到 .env 默认值。
  router.post('/api/config/reset', async (_req, res) => {
    const agent = await configStore.reset();
    res.json(configPayload(agent));
  });

  router.post('/api/config/profile', async (req, res) => {
    try {
      const agent = await configStore.applyProfile(req.body?.profile);
      res.json(configPayload(agent));
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
  });

  router.put('/api/config/mcp/:name', async (req, res) => {
    try {
      const mcpServers = await configStore.updateMcpServer(req.params.name, req.body);
      res.json({ mcpServers });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
  });

  router.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const mcpServers = await configStore.updateMcpServer(req.params.name, null);
      res.json({ mcpServers });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
  });

  router.post('/api/config/mcp/:name/test', async (req, res) => {
    try {
      res.json(await testMcpConnection(req.params.name));
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'MCP 连接失败' });
    }
  });

  return router;
}
