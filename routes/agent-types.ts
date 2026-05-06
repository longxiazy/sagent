export interface AgentRouterContext {
  runDesktopAgent: any;
  agentRunStore: any;
  approvalStore: any;
  memoryDir: string;
  checkpointDir: string;
  domainRules: any;
  modelConfig: any[];
  openai_client: any;
  anthropic_client: any;
}
