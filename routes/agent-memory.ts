import { Router } from 'express';
import {
  loadMemory,
  saveMemory,
  compactConversationMemory,
  clearMemory,
  clearProjectKnowledge,
} from '../agent/core/memory.ts';
import { summarizeText } from '../agent/core/summarizer.ts';
import { log } from '../helpers/logger.ts';
import { tReq } from '../helpers/i18n.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentMemoryRouter({
  memoryDir,
  modelConfig,
  registry,
  projectStore,
}: AgentRouterContext) {
  const router = Router();

  // 解析本次请求的记忆目录：?projectId 命中项目用项目目录，否则取 active，再否则全局。
  const resolveDir = (req: any) => {
    const pid = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    return resolveRunPaths(projectStore, pid, memoryDir).dataDir;
  };

  router.get('/api/agent/memory', async (req, res) => {
    try {
      const memory = await loadMemory(resolveDir(req));
      res.json({
        conversationCount: memory?.conversation?.length ?? 0,
        summaryLength: memory?.conversationSummary?.length ?? 0,
        conversation: memory?.conversation ?? [],
        conversationSummary: memory?.conversationSummary ?? '',
        lastCompactedAt: memory?.lastCompactedAt ?? '',
        projectKnowledge: memory?.projectKnowledge ?? { structure: [], paths: {}, preferences: [], learnings: [] },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/agent/compact', async (req, res) => {
    try {
      const dir = resolveDir(req);
      const memory = await loadMemory(dir);
      if (memory) {
        const summaryModel = modelConfig?.[0]?.id;
        log.info(`[Memory] 手动压缩 ${memory.conversation.length} 条, 摘要模型: ${summaryModel || '无'}`);
        const memStart = Date.now();
        await compactConversationMemory(memory, {
          summarizeFn: summaryModel
            ? (text: string) => summarizeText({ text, registry, model: summaryModel })
            : undefined,
        });
        await saveMemory(dir, memory);
        log.info(`[Memory] 手动压缩完成，保留 ${memory.conversation.length} 条, 耗时 ${Date.now() - memStart}ms`);
        res.json({ ok: true, message: tReq(req, 'memory.compacted', { n: memory.conversation.length }) });
      } else {
        res.json({ ok: false, message: tReq(req, 'memory.noData') });
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.delete('/api/agent/memory', async (req, res) => {
    try {
      await clearMemory(resolveDir(req));
      log.info('[Memory] 已清空全部记忆');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/agent/memory/knowledge', async (req, res) => {
    try {
      await clearProjectKnowledge(resolveDir(req));
      log.info('[Memory] 已清空项目知识');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
