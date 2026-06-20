/**
 * Project Router — 项目的增删改查与激活
 *
 * 端点:
 *   GET    /api/projects              列表 + activeProjectId
 *   POST   /api/projects              新建 { name, rootPath }
 *   PATCH  /api/projects/:id          重命名 / 改根路径 { name?, rootPath? }
 *   DELETE /api/projects/:id          删除(仅移除注册表条目,保留磁盘数据)
 *   POST   /api/projects/:id/activate 设为当前项目(:id 传 "none" 回到无项目态)
 */

import { Router } from 'express';
import { log } from '../helpers/logger.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentProjectsRouter({ projectStore }: AgentRouterContext) {
  const router = Router();

  router.get('/api/projects', (_req, res) => {
    res.json(projectStore.list());
  });

  router.post('/api/projects', async (req, res) => {
    try {
      const { name, rootPath } = req.body ?? {};
      const project = await projectStore.create({ name, rootPath });
      log.info(`[Project] 新建项目 ${project.projectId} name=${project.name} root=${project.rootPath}`);
      res.json({ ok: true, project, activeProjectId: projectStore.list().activeProjectId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/api/projects/:id', async (req, res) => {
    try {
      const { name, rootPath } = req.body ?? {};
      const project = await projectStore.update(req.params.id, { name, rootPath });
      log.info(`[Project] 更新项目 ${project.projectId}`);
      res.json({ ok: true, project });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/projects/:id', async (req, res) => {
    try {
      const result = await projectStore.remove(req.params.id);
      log.info(`[Project] 删除项目 ${req.params.id}`);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/projects/:id/activate', async (req, res) => {
    try {
      const target = req.params.id === 'none' ? null : req.params.id;
      const activeProjectId = await projectStore.setActive(target);
      log.info(`[Project] 切换当前项目 → ${activeProjectId ?? '(无项目)'}`);
      res.json({ ok: true, activeProjectId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
