import { Router } from 'express';
import {
  loadMemory,
  clearMemory,
} from '../agent/core/memory.ts';
import { log } from '../helpers/logger.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentMemoryRouter({
  memoryDir,
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
        projectKnowledge: memory?.projectKnowledge ?? { structure: [], paths: {}, preferences: [], learnings: [] },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/agent/memory', async (req, res) => {
    try {
      await clearMemory(resolveDir(req));
      log.info('[Memory] 已清空项目知识');
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
