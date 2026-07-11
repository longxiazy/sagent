import {
  saveMemory,
  loadMemory,
  extractConversationEntry,
  extractProjectKnowledge,
  compactConversationMemory,
} from '../agent/core/memory.ts';
import { summarizeText } from '../agent/core/summarizer.ts';
import { log } from '../helpers/logger.ts';
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
  const entry = extractConversationEntry({ task: normalizedTask, result: { answer, steps }, model, stepModels });
  memory.conversation.push(entry);
  extractProjectKnowledge(memory, { task: normalizedTask, result: { answer, steps } });

  const modelCounts: Record<string, number> = {};
  for (const selectedModel of Object.values(stepModels)) {
    modelCounts[selectedModel as string] = (modelCounts[selectedModel as string] || 0) + 1;
  }

  const summaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const modelStats = Object.entries(modelCounts).map(([m, c]) => `${m.split('/').pop()}×${c}`).join(', ');
  log.info(`[Memory] 开始压缩记忆 ${memory.conversation.length} 条, 摘要模型: ${summaryModel?.split('/').pop() || '无'} (本轮 ${modelStats || '无竞速'})`);

  const memStart = Date.now();
  await compactConversationMemory(memory, {
    summarizeFn: summaryModel
      ? (text: string) => summarizeText({ text, registry, model: summaryModel })
      : undefined,
  });
  await saveMemory(memoryDir, memory);
  log.info(`[Memory] 压缩完成，保留 ${memory.conversation.length} 条, 耗时 ${Date.now() - memStart}ms, 摘要长度 ${memory.conversationSummary.length}`);
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
