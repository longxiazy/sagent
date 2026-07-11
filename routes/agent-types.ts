import type { ProviderRegistry } from '../agent/core/providers/registry.ts';
import type { ModelInfo } from '../agent/core/providers/types.ts';
import type { RuntimeConfigStore } from '../agent/core/runtime-config.ts';
import type { ProjectStore } from '../agent/core/project-store.ts';
import type {
  AgentRunStore,
  ApprovalStore,
  DesktopAgentRunner,
  DomainRules,
} from '../agent/core/contracts.ts';

export interface AgentRouterContext {
  runDesktopAgent: DesktopAgentRunner;
  agentRunStore: AgentRunStore;
  approvalStore: ApprovalStore;
  memoryDir: string;
  checkpointDir: string;
  domainRules?: DomainRules;
  modelConfig: ModelInfo[];
  registry: ProviderRegistry;
  runtimeConfig: RuntimeConfigStore;
  projectStore: ProjectStore;
}
