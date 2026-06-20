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
    projectId,
  } = reqBody ?? {};

  if (typeof task !== 'string' || !task.trim()) {
    // 返回 i18n key，由调用方路由（有 req）翻译成对应语言。
    return { error: 'run.taskEmpty' };
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
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId : null,
  };
}

export async function resolveCheckpointSeed(checkpointDir: string, fromCheckpoint: any) {
  let checkpointInitialStep;
  let checkpointInitialHistory;

  if (fromCheckpoint && checkpointDir) {
    const cpRunId = fromCheckpoint.runId;
    const cpStep = fromCheckpoint.step;
    if (typeof cpRunId === 'string' && typeof cpStep === 'number') {
      // 加载目标步骤前一步的快照，保留之前的上下文，从目标步重新执行
      const snapshot = await loadLatestHealthySnapshot(checkpointDir, cpRunId, cpStep - 1);
      if (snapshot) {
        checkpointInitialStep = cpStep;
        checkpointInitialHistory = snapshot.history || [];
      } else {
        // 目标是第 1 步且无更早快照 → 从头开始
        checkpointInitialStep = 1;
        checkpointInitialHistory = [];
      }
    }
  }

  return { checkpointInitialStep, checkpointInitialHistory };
}
