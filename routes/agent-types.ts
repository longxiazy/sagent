import type { ProviderRegistry } from '../agent/core/providers/registry.ts';

export interface AgentRouterContext {
  runDesktopAgent: any;
  agentRunStore: any;
  approvalStore: any;
  memoryDir: string;
  checkpointDir: string;
  domainRules: any;
  modelConfig: any[];
  registry: ProviderRegistry;
}
