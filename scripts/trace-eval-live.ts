/**
 * trace-eval 决策回放（--live）— 用真实模型对录制步骤逐步重新决策，与录制动作对比。
 *
 * 每个回放点只发一次 agentPlan 请求：重建当时的 {task, step, history, observation}
 * prompt 上下文 → provider.agentPlan（与 runtime 决策同一条代码路径）→ 与录制的
 * action 比对。不执行任何工具、不写任何运行状态，唯一成本是模型 token。
 *
 * 单独成文件并由 trace-eval.ts 动态导入：纯离线评测路径不加载 OpenAI/Gemini SDK。
 */

import { createClients } from '../agent/core/ai-client.ts';
import { createProviderRegistry } from '../agent/core/providers/registry.ts';
import { buildStepPromptContext } from '../agent/core/trace-replay.ts';
import type { FixtureCurrent } from './trace-eval.ts';

interface LiveCliConfig {
  liveModels: string[] | null;
  maxLiveSteps: number;
}

export interface LiveStepRow {
  fixture: string;
  model: string;
  step: number;
  parsedOk: boolean;
  toolMatch: boolean | null;
  typeMatch: boolean | null;
  recorded: string;
  replayed: string;
  error?: string;
}

export interface LiveModelSummary {
  model: string;
  steps: number;
  parsedOk: number;
  toolMatch: number;
  typeMatch: number;
  earlyFinish: number;
  missedFinish: number;
  promptTokens: number;
  completionTokens: number;
}

function actionLabel(action: any): string {
  if (!action || typeof action !== 'object') return '?';
  return `${action.tool ?? '?'}.${action.type ?? '?'}`;
}

export async function runLiveEval(cfg: LiveCliConfig, currents: FixtureCurrent[]) {
  const { openai_client, gemini_client } = createClients();
  const registry = createProviderRegistry({ openai_client, gemini_client });
  let modelConfig: any[] | undefined;
  try {
    modelConfig = await registry.loadModelConfig();
  } catch (err: any) {
    console.warn(`⚠️ 获取模型列表失败（继续，但 max_tokens/角色适配可能不精确）: ${err?.message || err}`);
    modelConfig = undefined;
  }

  const rows: LiveStepRow[] = [];
  const summaries = new Map<string, LiveModelSummary>();
  let budget = cfg.maxLiveSteps;
  let truncated = false;

  console.log(`\n决策回放（--live，总请求预算 ${cfg.maxLiveSteps}）\n`);

  outer:
  for (const current of currents) {
    const run = current.run;
    if (!run.steps.length) continue;
    const models = cfg.liveModels?.length ? cfg.liveModels : run.agentModels;
    if (!models.length) {
      console.warn(`⚠️ [${current.id}] 无可用模型（run_meta 无 agentModels 且未指定 --models），跳过`);
      continue;
    }

    for (const model of models) {
      const summary = summaries.get(model) || {
        model, steps: 0, parsedOk: 0, toolMatch: 0, typeMatch: 0,
        earlyFinish: 0, missedFinish: 0, promptTokens: 0, completionTokens: 0,
      };
      summaries.set(model, summary);

      for (let index = 0; index < run.steps.length; index += 1) {
        if (budget <= 0) { truncated = true; break outer; }
        const recorded = run.steps[index];
        if (!recorded.action) continue; // 审批被拒的步没有录制动作，无从比对

        budget -= 1;
        summary.steps += 1;
        const context = buildStepPromptContext(run, index);
        const row: LiveStepRow = {
          fixture: current.id,
          model,
          step: recorded.step,
          parsedOk: false,
          toolMatch: null,
          typeMatch: null,
          recorded: actionLabel(recorded.action),
          replayed: '-',
        };

        try {
          const provider = registry.resolve(model, modelConfig as any);
          const result = await provider.agentPlan({
            model,
            modelConfig: modelConfig as any,
            task: context.task,
            step: context.step,
            history: context.history,
            observation: context.observation,
          });
          row.parsedOk = true;
          summary.parsedOk += 1;
          row.replayed = actionLabel(result.action);
          row.toolMatch = result.action?.tool === recorded.action.tool;
          row.typeMatch = row.toolMatch && result.action?.type === recorded.action.type;
          if (row.toolMatch) summary.toolMatch += 1;
          if (row.typeMatch) summary.typeMatch += 1;

          const recordedFinish = recorded.action.type === 'finish';
          const replayedFinish = result.action?.type === 'finish';
          if (replayedFinish && !recordedFinish) summary.earlyFinish += 1;
          if (!replayedFinish && recordedFinish) summary.missedFinish += 1;

          summary.promptTokens += Number(result.usage?.prompt_tokens) || 0;
          summary.completionTokens += Number(result.usage?.completion_tokens ?? result.usage?.output_tokens) || 0;
        } catch (err: any) {
          row.error = String(err?.message || err).slice(0, 200);
        }

        rows.push(row);
        console.log(
          `  [${current.id}] step ${row.step} ${model}: 录制=${row.recorded} 回放=${row.replayed}` +
          `${row.typeMatch ? ' ✅' : row.toolMatch ? ' ~tool' : row.parsedOk ? ' ✗' : ` ❌(${row.error})`}`,
        );
      }
    }
  }

  if (truncated) {
    console.warn(`⚠️ 已达 --max-steps 预算（${cfg.maxLiveSteps}），其余步骤未回放`);
  }

  const summaryRows = [...summaries.values()].map(summary => ({
    model: summary.model,
    steps: summary.steps,
    'parse✓': summary.parsedOk,
    'tool✓': summary.toolMatch,
    'type✓': summary.typeMatch,
    earlyFinish: summary.earlyFinish,
    missedFinish: summary.missedFinish,
    tokens: `${summary.promptTokens}+${summary.completionTokens}`,
  }));
  if (summaryRows.length) console.table(summaryRows);

  return {
    budget: cfg.maxLiveSteps,
    truncated,
    models: [...summaries.values()],
    rows,
  };
}
