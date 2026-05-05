import { Router } from 'express';
import type { AgentRouterContext } from './agent-types.ts';
import { createAgentRunStartRouter } from './agent-run-start.ts';
import { createAgentRunControlRouter } from './agent-run-control.ts';

export function createAgentRunRouter(context: AgentRouterContext) {
  const router = Router();

  router.use(createAgentRunStartRouter(context));
  router.use(createAgentRunControlRouter(context));

  return router;
}
