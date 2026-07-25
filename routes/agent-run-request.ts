/** 解析 POST /api/agent 输入，并把 fromCheckpoint 转换成 runtime 的起始 step/history。 */

import { loadLatestHealthySnapshot } from '../agent/core/checkpoint.ts';

function uniqueModelIds(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))];
}

export function parseAgentRunRequest(reqBody: any) {
  const {
    task,
    model,
    models: reqModels,
    strategy = 'race',
    headless,
    privateMode,
    memory: useMemory = true,
    messages: conversationHistory,
    fromCheckpoint,
    projectId,
    sessionId,
  } = reqBody ?? {};

  if (typeof task !== 'string' || !task.trim()) {
    // 返回 i18n key，由调用方路由（有 req）翻译成对应语言。
    return { error: 'run.taskEmpty' };
  }

  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  const requestedModels = uniqueModelIds(reqModels);
  const agentModels = requestedModels.length > 0
    ? requestedModels
    : requestedModel
      ? [requestedModel]
      : [];

  if (agentModels.length === 0) {
    return { error: 'run.modelRequired' };
  }

  return {
    task,
    model: agentModels[0],
    agentModels,
    strategy,
    headless,
    privateMode: privateMode === true,
    useMemory,
    conversationHistory,
    fromCheckpoint,
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId : null,
    sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
  };
}

export async function resolveCheckpointSeed(checkpointDir: string | null | undefined, fromCheckpoint: any) {
  let checkpointInitialStep;
  let checkpointInitialHistory;

  // 隐私模式传入 null checkpointDir，因此即使请求带 fromCheckpoint 也不会读取磁盘快照。
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
        // 找不到目标步之前的健康快照（包括回滚到第 1 步）→ 从头开始。
        checkpointInitialStep = 1;
        checkpointInitialHistory = [];
      }
    }
  }

  return { checkpointInitialStep, checkpointInitialHistory };
}
