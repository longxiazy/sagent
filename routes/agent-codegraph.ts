/**
 * Codegraph Router — 代码知识图谱的查看 / 重新索引 / 搜索
 *
 * 端点(均按 ?projectId 隔离;未指定即全局,语义同 resolveRunPaths):
 *   GET  /api/agent/codegraph              返回 codegraph.json 内容 + 当前索引任务状态(供轮询进度)
 *   POST /api/agent/codegraph/reindex      body { model } 触发后台异步索引,立即返回;已在跑→409
 *   GET  /api/agent/codegraph/query?q=     纯静态关键词搜索匹配模块
 *
 * 索引是分钟级重操作:POST 立即返回,后台跑 scanSkeleton → buildCodegraphWithLLM → saveCodegraph,
 * 进度记录在内存 IndexJob,前端轮询 GET 拿 done/total。
 */

import { Router } from 'express';
import path from 'node:path';
import {
  loadCodegraph,
  saveCodegraph,
  scanSkeleton,
  buildCodegraphWithLLM,
  queryCodegraph,
} from '../agent/core/codegraph.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';
import { log } from '../helpers/logger.ts';
import type { AgentRouterContext } from './agent-types.ts';

interface IndexJob {
  status: 'indexing' | 'done' | 'error';
  phase: 'scanning' | 'describing';
  total: number;
  done: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export function createAgentCodegraphRouter({
  memoryDir,
  modelConfig,
  registry,
  projectStore,
}: AgentRouterContext) {
  const router = Router();

  // 索引任务状态:按项目隔离(无项目用 __global__),供前端轮询进度。
  const jobs = new Map<string, IndexJob>();
  const jobKey = (projectId: string | null) => projectId || '__global__';

  const resolvePaths = (req: any) => {
    const pid = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    return resolveRunPaths(projectStore, pid, memoryDir);
  };

  // 当前图谱 + 索引任务状态
  router.get('/api/agent/codegraph', async (req, res) => {
    try {
      const { projectId, dataDir } = resolvePaths(req);
      const graph = await loadCodegraph(dataDir);
      res.json({ graph, job: jobs.get(jobKey(projectId)) ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 触发后台重新索引
  router.post('/api/agent/codegraph/reindex', async (req, res) => {
    const { projectId, projectRoot, dataDir } = resolvePaths(req);
    const key = jobKey(projectId);

    const existing = jobs.get(key);
    if (existing?.status === 'indexing') {
      return res.status(409).json({ error: '索引正在进行中', job: existing });
    }

    const model = req.body?.model;
    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: '缺少 model 参数' });
    }

    const job: IndexJob = { status: 'indexing', phase: 'scanning', total: 0, done: 0, startedAt: Date.now() };
    jobs.set(key, job);

    // 立即返回,后台异步执行(不 await)。
    res.json({ ok: true, job });

    (async () => {
      try {
        const project = projectId ? projectStore.get(projectId) : null;
        const projectName = project?.name || path.basename(projectRoot) || 'project';
        log.info(`[Codegraph] 开始索引 project=${projectName} root=${projectRoot} model=${model}`);

        const skeleton = await scanSkeleton(projectRoot);
        job.phase = 'describing';

        const graph = await buildCodegraphWithLLM({
          skeleton,
          registry,
          model,
          modelConfig,
          projectName,
          rootPath: projectRoot,
          onProgress: (done, total) => {
            job.done = done;
            job.total = total;
          },
        });

        await saveCodegraph(dataDir, graph);
        job.status = 'done';
        job.finishedAt = Date.now();
        log.info(`[Codegraph] 索引完成 project=${projectName} 模块=${graph.modules.length} 覆盖率=${graph.stats.coverage} 耗时=${Date.now() - job.startedAt}ms`);
      } catch (err: any) {
        job.status = 'error';
        job.error = err?.message || String(err);
        job.finishedAt = Date.now();
        log.warn(`[Codegraph] 索引失败: ${job.error}`);
      }
    })();
  });

  // 静态关键词搜索
  router.get('/api/agent/codegraph/query', async (req, res) => {
    try {
      const { dataDir } = resolvePaths(req);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const graph = await loadCodegraph(dataDir);
      res.json({ results: queryCodegraph(graph, q) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
