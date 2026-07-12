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
import { createAgentSessionsRouter } from './agent-sessions.ts';
import { createSessionStore } from '../agent/core/session-store.ts';
import type { AgentRouterContext } from './agent-types.ts';

export function createAgentRouter(context: Omit<AgentRouterContext, 'sessionStore'> & { sessionStore?: AgentRouterContext['sessionStore'] }) {
  const router = Router();
  const fullContext: AgentRouterContext = {
    ...context,
    sessionStore: context.sessionStore || createSessionStore({ memoryDir: context.memoryDir, projectStore: context.projectStore }),
  };

  router.use(createAgentRunRouter(fullContext));
  router.use(createAgentApprovalRouter(fullContext));
  router.use(createAgentFetchRulesRouter(fullContext));
  router.use(createAgentConfigRouter(fullContext));
  router.use(createAgentMemoryRouter(fullContext));
  router.use(createAgentCheckpointRouter(fullContext));
  router.use(createAgentTraceRouter(fullContext));
  router.use(createAgentUploadsRouter(fullContext));
  router.use(createAgentProjectsRouter(fullContext));
  router.use(createAgentCodegraphRouter(fullContext));
  router.use(createAgentContextRouter(fullContext));
  router.use(createAgentSessionsRouter(fullContext));

  return router;
}
