/**
 * Agent route composition root.
 *
 * 保留统一的 createAgentRouter() 入口，把不同职责的子路由在这里装配起来：
 * - run: 启动、取消、重连、活动运行查询
 * - approvals: 审批与问答
 * - fetch rules: 域名抓取规则
 * - memory: 记忆查看/压缩/清理
 * - checkpoints: 检查点与回滚
 */

import { Router } from 'express';
import { createAgentRunRouter } from './agent-run.ts';
import { createAgentApprovalRouter } from './agent-approval.ts';
import { createAgentFetchRulesRouter } from './agent-fetch-rules.ts';
import { createAgentConfigRouter } from './agent-config.ts';
import { createAgentMemoryRouter } from './agent-memory.ts';
import { createAgentCheckpointRouter } from './agent-checkpoints.ts';
import { createAgentTraceRouter } from './agent-traces.ts';
import { createAgentUploadsRouter } from './agent-uploads.ts';
import { createAgentProjectsRouter } from './agent-projects.ts';
import { createAgentCodegraphRouter } from './agent-codegraph.ts';
import { createAgentContextRouter } from './agent-context.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentRouter(context: AgentRouterContext) {
  const router = Router();

  router.use(createAgentRunRouter(context));
  router.use(createAgentApprovalRouter(context));
  router.use(createAgentFetchRulesRouter(context));
  router.use(createAgentConfigRouter(context));
  router.use(createAgentMemoryRouter(context));
  router.use(createAgentCheckpointRouter(context));
  router.use(createAgentTraceRouter(context));
  router.use(createAgentUploadsRouter(context));
  router.use(createAgentProjectsRouter(context));
  router.use(createAgentCodegraphRouter(context));
  router.use(createAgentContextRouter(context));

  return router;
}
