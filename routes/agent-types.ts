import type { ProviderRegistry } from '../agent/core/providers/registry.ts';
import type { RuntimeConfigStore } from '../agent/core/runtime-config.ts';

export interface AgentRouterContext {
  runDesktopAgent: any;
  agentRunStore: any;
  approvalStore: any;
  memoryDir: string;
  checkpointDir: string;
  domainRules: any;
  modelConfig: any[];
  registry: ProviderRegistry;
  runtimeConfig: RuntimeConfigStore;
}
