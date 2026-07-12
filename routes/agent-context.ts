import { Router } from 'express';
import { loadMemoryForPrompt } from '../helpers/run-agent.ts';
import { resolveRunPaths } from '../agent/core/project-store.ts';
import {
  buildModelContextEstimate,
  summarizeContextEstimates,
} from '../agent/core/context-estimate.ts';
import type { AgentRouterContext } from './agent-types.ts';

function uniqueModelIds(value: any) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}

function normalizeConversationHistory(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-10)
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content }));
}

export function createAgentContextRouter({
  memoryDir,
  modelConfig,
  registry,
  projectStore,
}: AgentRouterContext) {
  const router = Router();

  router.post('/api/agent/context', async (req, res) => {
    const {
      task = '',
      model,
      models: reqModels,
      memory: useMemory = true,
      messages,
      projectId,
    } = req.body ?? {};

    const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
    const agentModels = uniqueModelIds(reqModels);
    const models = agentModels.length > 0
      ? agentModels
      : requestedModel
        ? [requestedModel]
        : [];

    if (models.length === 0) {
      return res.status(400).json({ error: 'model is required' });
    }
    const incompatibleModels = models.filter(modelId => (
      modelConfig.find(item => item.id === modelId)?.agentCompatible === false
    ));
    if (incompatibleModels.length > 0) {
      return res.status(400).json({
        error: `models are not compatible with the Desktop Agent: ${incompatibleModels.join(', ')}`,
      });
    }

    const { projectRoot, dataDir } = resolveRunPaths(
      projectStore,
      typeof projectId === 'string' && projectId.trim() ? projectId : null,
      memoryDir
    );
    const loaded = useMemory ? await loadMemoryForPrompt(dataDir) : { systemPrompt: '' };
    const conversationHistory = normalizeConversationHistory(messages);
    const normalizedTask = typeof task === 'string' ? task : String(task || '');

    const estimates = models.map(modelId => {
      const provider = registry.resolve(modelId, modelConfig);
      const modelInfo = modelConfig.find(item => item.id === modelId) || null;
      return buildModelContextEstimate({
        modelId,
        modelInfo,
        providerName: provider.name,
        task: normalizedTask,
        systemPrompt: loaded.systemPrompt,
        conversationHistory,
        projectRoot,
      });
    });

    return res.json(summarizeContextEstimates(estimates));
  });

  return router;
}
