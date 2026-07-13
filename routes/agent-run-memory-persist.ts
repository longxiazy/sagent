import {
  saveMemory,
  loadMemory,
  extractProjectKnowledge,
} from '../agent/core/memory.ts';
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
