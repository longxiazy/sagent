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
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentMemoryRouter({
  memoryDir,
  modelConfig,
  registry,
}: AgentRouterContext) {
  const router = Router();

  router.get('/api/agent/memory', async (_req, res) => {
    try {
      const memory = await loadMemory(memoryDir);
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
      const memory = await loadMemory(memoryDir);
      if (memory) {
        const summaryModel = modelConfig?.[0]?.id;
        log.info(`[Memory] 手动压缩 ${memory.conversation.length} 条, 摘要模型: ${summaryModel || '无'}`);
        const memStart = Date.now();
        await compactConversationMemory(memory, {
          summarizeFn: summaryModel
            ? (text: string) => summarizeText({ text, registry, model: summaryModel })
            : undefined,
        });
        await saveMemory(memoryDir, memory);
        log.info(`[Memory] 手动压缩完成，保留 ${memory.conversation.length} 条, 耗时 ${Date.now() - memStart}ms`);
        res.json({ ok: true, message: tReq(req, 'memory.compacted', { n: memory.conversation.length }) });
      } else {
        res.json({ ok: false, message: tReq(req, 'memory.noData') });
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.delete('/api/agent/memory', async (_req, res) => {
    try {
      await clearMemory(memoryDir);
      log.info('[Memory] 已清空全部记忆');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/agent/memory/knowledge', async (_req, res) => {
    try {
      await clearProjectKnowledge(memoryDir);
      log.info('[Memory] 已清空项目知识');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
