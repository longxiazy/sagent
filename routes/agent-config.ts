import { Router } from 'express';
import { deriveProviderName } from '../agent/core/ai-client.ts';
import { tReq } from '../helpers/i18n.ts';
import type { AgentRouterContext } from './agent-types.ts';
import { loadChromeMcpConfig } from '../agent/tools/chrome/mcp-client.ts';
import { readProjectToolsOverride, writeProjectToolsOverride } from '../agent/core/tool-model-resolver.ts';

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
  return { servers, sources };
}

export function createAgentConfigRouter({ configStore, projectStore }: AgentRouterContext) {
  const router = Router();
  const configPayload = (agent = configStore.get()) => {
    const mcp = effectiveMcpServers(configStore);
    return {
      agent,
      defaults: configStore.defaults(),
      sources: configStore.sources(),
      schema: configStore.schema(),
      profiles: configStore.profiles(),
      profile: configStore.profile(),
      // 搭配失效的提示（如历史窗口大于总步数）。不阻断保存，由前端展示。
      warnings: configStore.warnings(),
      tools: configStore.tools(),
      // 设置页要按「项目覆盖 → 全局配置 → 环境变量 → 当前主模型」讲清 vision/distill 的
      // 取值优先级。切到项目作用域时上面的 tools 会被项目 override 顶掉，所以这里把
      // 全局值和环境变量单独给出，否则前端说不清「下一层」是什么。
      globalTools: configStore.tools(),
      toolEnvModels: {
        vision: (process.env.VISION_MODEL || '').trim(),
        distill: (process.env.DISTILL_MODEL || '').trim(),
      },
      // execution 是启动期配置；返回 effective 值与来源，便于 UI 解释环境变量覆盖。
      execution: configStore.execution(),
      executionSources: configStore.executionSources(),
      mcpServers: mcp.servers,
      mcpSources: mcp.sources,
    };
  };

  // 当前 Agent 行为参数 + schema 内置默认值（供前端「恢复默认」对照）+ Key 只读状态。
  // ?projectId=<id> 时只返回项目级 vision/distill override；否则返回全局 tools，
  // 其中全局段还可能包含 screenshots 配置。
  router.get('/api/config', async (req, res) => {
    const payload: any = { ...configPayload(), keys: describeKeys() };
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (projectId) {
      payload.tools = await readProjectToolsOverride(projectStore.dataDir(projectId));
      payload.toolsScope = 'project';
    } else {
      payload.toolsScope = 'global';
    }
    res.json(payload);
  });

  // 更新 tools。项目级仅接受 vision/distill model；全局由 configStore 归一化并保留 screenshots。
  router.put('/api/config/tools', async (req, res) => {
    try {
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
      const tools = req.body?.tools ?? {};
      const saved = projectId
        ? await writeProjectToolsOverride(projectStore.dataDir(projectId), tools)
        : await configStore.updateTools(tools);
      // globalTools 一并回传：保存全局时它就是新值，保存项目覆盖时它是下一层的现值，
      // 前端的优先级说明两种情况都要刷新。
      res.json({ tools: saved, globalTools: configStore.tools(), scope: projectId ? 'project' : 'global' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
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

  // 更新 Worker 启动配置；body: { sandboxedWorkers, workerSandbox }。
  // 该配置只在后端下一次启动时读取，成功响应仍返回完整配置供前端同步状态。
  router.put('/api/config/execution', async (req, res) => {
    try {
      await configStore.updateExecution(req.body ?? {});
      res.json(configPayload());
    } catch (err: any) {
      res.status(400).json({ error: err?.message || tReq(req, 'config.validationFailed') });
    }
  });

  // 只清空 Agent 参数覆盖并回到内置默认值；tools/MCP/execution 保持不变。
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
