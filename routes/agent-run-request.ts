import { loadLatestHealthySnapshot } from '../agent/core/checkpoint.ts';

export function parseAgentRunRequest(reqBody: any, defaultModel: string) {
  const {
    task,
    model = defaultModel,
    models: reqModels,
    strategy = 'race',
    headless,
    memory: useMemory = true,
    messages: conversationHistory,
    fromCheckpoint,
  } = reqBody ?? {};

  if (typeof task !== 'string' || !task.trim()) {
    return { error: 'task 不能为空' };
  }

  return {
    task,
    model,
    agentModels: Array.isArray(reqModels) && reqModels.length > 0 ? reqModels : [model],
    strategy,
    headless,
    useMemory,
    conversationHistory,
    fromCheckpoint,
  };
}

export async function resolveCheckpointSeed(checkpointDir: string, fromCheckpoint: any) {
  let checkpointInitialStep;
  let checkpointInitialHistory;

  if (fromCheckpoint && checkpointDir) {
    const cpRunId = fromCheckpoint.runId;
    const cpStep = fromCheckpoint.step;
    if (typeof cpRunId === 'string' && typeof cpStep === 'number') {
      const snapshot = await loadLatestHealthySnapshot(checkpointDir, cpRunId, cpStep);
      if (snapshot) {
        checkpointInitialStep = snapshot.step + 1;
        checkpointInitialHistory = snapshot.history || [];
      }
    }
  }

  return { checkpointInitialStep, checkpointInitialHistory };
}
