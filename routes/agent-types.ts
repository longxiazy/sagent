import type { ProviderRegistry } from '../agent/core/providers/registry.ts';
import type { ModelInfo } from '../agent/core/providers/types.ts';
import type { ConfigStore } from '../agent/core/config-store.ts';
import type { ProjectStore } from '../agent/core/project-store.ts';
import type { SessionStore } from '../agent/core/session-store.ts';
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
  configStore: ConfigStore;
  projectStore: ProjectStore;
  sessionStore: SessionStore;
}
