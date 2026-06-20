import { Router } from 'express';
import { safeJson } from '../agent/core/utils.ts';
import { log } from '../helpers/logger.ts';
import { initSse, writeSse } from '../helpers/streaming.ts';
import { tReq } from '../helpers/i18n.ts';
import type { ProviderRegistry } from '../agent/core/providers/registry.ts';
import type { ProjectStore } from '../agent/core/project-store.ts';

export function createChatRouter({ registry, modelConfig, projectStore }: { registry: ProviderRegistry; modelConfig: any[]; projectStore?: ProjectStore }) {
  const router = Router();
  const defaultModel = modelConfig?.[0]?.id || 'minimaxai/minimax-m2.7';

  router.post('/api/chat', async (req, res) => {
    const {
      messages,
      model = defaultModel,
      temperature = 1,
      top_p = 0.95,
      max_tokens = 8192,
      projectId,
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: tReq(req, 'chat.messagesMustBeArray') });
    }

    // chat 模式工具(read/list/search/run_safe)的文件根：命中项目用项目 rootPath，否则回退 process.cwd()。
    // 未指定 projectId 即全局(不按 getActive 兜底)，与 resolveRunPaths 语义一致。
    const project = projectStore && typeof projectId === 'string' && projectId ? projectStore.get(projectId) : null;
    const cwd = project?.rootPath ?? null;

    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const startedAt = Date.now();
    log.info(`[${time}] POST /api/chat model=${model} messages=${safeJson(messages)}`);

    initSse(res);

    try {
      const provider = registry.resolve(model, modelConfig);
      await provider.chatStream({ model, messages, temperature, top_p, max_tokens, res, startedAt, cwd });
    } catch (err: any) {
      log.error('API error:', err);
      writeSse(res, { error: err.message });
    } finally {
      res.end();
    }
    return;
  });

  return router;
}
