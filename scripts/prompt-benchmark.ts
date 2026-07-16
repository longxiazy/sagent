import { configStore } from '../agent/core/config-store.ts';
import { buildGeminiAgentPromptPayload, buildNvidiaTaskMessages } from '../agent/core/prompts.ts';
import { estimatePayloadTokens } from '../agent/core/context-estimate.ts';

const CASES = [
  { id: 'casual', task: '你好，介绍一下你自己' },
  { id: 'web', task: '查询今天苏州天气' },
  { id: 'code', task: '检查项目代码并运行测试' },
  { id: 'codex', task: '用 Codex 检查项目可升级项' },
  { id: 'chrome', task: '用 Chrome DevTools 检查网络请求' },
];

await configStore.init('./data');

const rows = CASES.map(({ id, task }) => {
  const context = { task, step: 1, history: [], observation: {} };
  const nvidia = buildNvidiaTaskMessages(context);
  const compact = buildNvidiaTaskMessages({ ...context, compact: true });
  const gemini = buildGeminiAgentPromptPayload(context);
  return {
    id,
    nvidiaTokens: estimatePayloadTokens(nvidia),
    nvidiaSystemChars: nvidia[0].content.length,
    nvidiaExamples: nvidia[0].content.split('\n').filter(line => line.startsWith('{"rationale":')).length,
    compactTokens: estimatePayloadTokens(compact),
    geminiTokens: estimatePayloadTokens(gemini),
    geminiSystemChars: gemini.systemInstruction.length,
    geminiTools: gemini.tools[0].functionDeclarations.length,
  };
});

console.table(rows);
