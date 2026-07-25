/** Project-memory persistence shared by fresh runs and checkpoint recovery. */

import {
  saveMemory,
  loadMemory,
  extractProjectKnowledge,
} from '../agent/core/memory.ts';
import { isPrivateRun } from '../helpers/private-run.ts';
import type { ProviderRegistry } from '../agent/core/providers/registry.ts';
import type { DesktopAgentResult } from '../agent/core/contracts.ts';

export async function persistAgentRunMemory({
  memory,
  memoryDir,
  normalizedTask,
  finalAnswer,
  agentError,
  agentResult,
  model,
  stepModels,
  registry,
}: {
  memory: any;
  memoryDir: string;
  normalizedTask: string;
  finalAnswer: string | null;
  agentError: Error | null;
  agentResult: DesktopAgentResult | null;
  model: string;
  stepModels: Record<number, string>;
  registry: ProviderRegistry;
}) {
  // Bottom-layer guard: callers already skip private runs, but recovered/indirect paths
  // must also be unable to write project knowledge while the private context is active.
  if (isPrivateRun()) return;
  const answer = finalAnswer || (agentError ? `失败: ${agentError.message.slice(0, 60)}` : '无结果');
  const steps = agentResult?.steps || [];
  extractProjectKnowledge(memory, { task: normalizedTask, result: { answer, steps } });
  await saveMemory(memoryDir, memory);
}

export async function persistRecoveredAgentRunMemory({
  memoryDir,
  task,
  result,
  model,
  registry,
}: {
  memoryDir: string;
  task: string;
  result: DesktopAgentResult;
  model: string;
  registry: ProviderRegistry;
}) {
  if (isPrivateRun()) return;
  const memory = await loadMemory(memoryDir);
  await persistAgentRunMemory({
    memory,
    memoryDir,
    normalizedTask: task,
    finalAnswer: result.answer,
    agentError: null,
    agentResult: result,
    model,
    stepModels: {},
    registry,
  });
}
