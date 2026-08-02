/**
 * 动态模型路由 —— 按任务难度重排候选模型的优先级
 *
 * 只调整顺序，不增删模型。真正消费这个顺序的是 planner：race 分批启动时排在
 * 前面的先跑，progressive 只把第一个当主模型。因此「重排顺序」实际等价于
 * 「决定谁承担主要工作」。vote 会启动全部模型，顺序对它没有影响。
 *
 * 由 agent.autoModelRouting 开关控制。四档预设一律关闭，默认也关闭——
 * 评分是启发式推断（见下），未必比用户自己排的顺序更准，因此不预设开启，
 * 交由用户按自己的模型组合判断是否需要。
 *
 * 难度判定（estimateTaskComplexity）按优先级短路，前一条命中就不再往下看：
 *   1. 最近三步内出现过失败 → high。失败往往意味着任务比表面复杂，换强模型重试。
 *   2. 已进入执行阶段且非首步 → high。写文件、跑命令这类有副作用的动作出错代价高。
 *   3. 任务描述的关键词倾向 → high / low
 *   4. 都不命中 → medium，此时不重排，保持用户给定的顺序。
 *
 * 评分（scoreModelForRouting）只能靠模型名与目录元信息做启发式推断——没有统一的
 * 能力字段可用，所以用参数量、上下文窗口和名称里的档位词（pro/flash/mini 等）
 * 拼出 capability / economy 两个分值。low 任务偏向 economy，high 任务偏向 capability。
 * 这是「猜」而非「测」，所以只用于排序，不用于淘汰模型：猜错最多是顺序不佳，
 * 不会让任何模型不可用。
 */

import type { ModelInfo } from './providers/types.ts';

type Complexity = 'low' | 'medium' | 'high';
type Phase = 'explore' | 'execute';

const LOW_COMPLEXITY_PATTERNS = [
  /查一下|搜索|搜一下|找文件|列出|统计|解释|说明|简单修复|看一下|看看/i,
  /\b(search|find|list|count|explain|summari[sz]e|read|show|inspect|simple fix)\b/i,
];

const HIGH_COMPLEXITY_PATTERNS = [
  /重构|重写|架构|多文件|性能优化|安全修复|实现|迁移|设计|排查|修复.*测试|端到端|并发|权限|认证|回归/i,
  /\b(refactor|rewrite|architecture|multi[-\s]?file|performance|security|implement|migration|debug|race condition|e2e|integration)\b/i,
];

const MUTATING_ACTIONS = new Set([
  'fs.write_file',
  'fs.edit_file',
  'fs.delete_file',
  'fs.move_file',
  'terminal.run_confirmed',
  'terminal.run_review',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.press',
  'chrome.chrome_call_tool',
]);

function uniqueModelIds(models: string[]) {
  return [...new Set(models.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function matchCount(text: string, patterns: RegExp[]) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function actionKey(action: any) {
  const tool = action?.tool || 'core';
  const type = action?.type || '';
  return `${tool}.${type}`;
}

function hasRecentFailure(history: any[]) {
  return history.slice(-3).some(entry => {
    const status = String(entry?.resultStatus || entry?.status || '').toLowerCase();
    const result = String(entry?.result || '');
    return status === 'failed' || /执行失败|error|failed|exception|timeout|超时/i.test(result);
  });
}

function inferPhase(history: any[]): Phase {
  const recent = history.slice(-2);
  return recent.some(entry => MUTATING_ACTIONS.has(actionKey(entry?.action))) ? 'execute' : 'explore';
}

export function estimateTaskComplexity({
  task,
  step = 1,
  history = [],
}: {
  task?: string;
  step?: number;
  history?: any[];
}): { complexity: Complexity; phase: Phase; reason: string } {
  const text = String(task || '');
  const lowSignals = matchCount(text, LOW_COMPLEXITY_PATTERNS);
  const highSignals = matchCount(text, HIGH_COMPLEXITY_PATTERNS);
  const recentFailure = hasRecentFailure(history);
  const phase = inferPhase(history);

  if (recentFailure) {
    return { complexity: 'high', phase, reason: 'recent-failure' };
  }
  if (phase === 'execute' && step > 1) {
    return { complexity: 'high', phase, reason: 'execution-phase' };
  }
  if (highSignals > lowSignals) {
    return { complexity: 'high', phase, reason: 'task-keyword' };
  }
  if (lowSignals > 0 && highSignals === 0) {
    return { complexity: 'low', phase, reason: 'task-keyword' };
  }
  return { complexity: 'medium', phase, reason: 'default' };
}

function modelInfoFor(model: string, modelConfig?: ModelInfo[] | null) {
  if (!Array.isArray(modelConfig)) return null;
  return modelConfig.find(item => item?.id === model || item?.aliases?.includes(model)) || null;
}

function modelText(model: string, info: ModelInfo | null) {
  return [
    model,
    info?.label,
    info?.provider,
    info?.publisher,
    info?.description,
    ...(info?.supportedGenerationMethods || []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function largestParameterB(text: string) {
  let largest = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)) {
    largest = Math.max(largest, Number(match[1]) || 0);
  }
  return largest;
}

export function scoreModelForRouting(model: string, modelConfig?: ModelInfo[] | null) {
  const info = modelInfoFor(model, modelConfig);
  const text = modelText(model, info);
  const paramsB = largestParameterB(text);
  const context = Number(info?.contextWindow || info?.inputTokenLimit || 0);

  let capability = 50;
  let economy = 50;

  if (/o3|o4|gpt-5|gpt-4|opus|sonnet|claude|pro|max|ultra|reasoning|deepseek.*pro|glm-?5|nemotron/.test(text)) capability += 28;
  if (/reasoning|code|coding|agent|tool/.test(text)) capability += 12;
  if (paramsB >= 70) capability += 10;
  if (paramsB >= 200) capability += 8;
  if (context >= 128_000) capability += 5;
  if (context >= 512_000) capability += 5;

  if (/flash|mini|nano|lite|small|fast|turbo|haiku|8b|7b|4b|minimax/.test(text)) economy += 30;
  if (/pro|max|ultra|opus|o3|gpt-5|gpt-4|large/.test(text)) economy -= 20;
  if (paramsB > 0 && paramsB <= 14) economy += 10;
  if (paramsB >= 70) economy -= 8;
  if (paramsB >= 200) economy -= 8;

  return { capability, economy, context };
}

function sortByScore(models: string[], scorer: (model: string, index: number) => number) {
  return [...models].sort((a, b) => {
    const delta = scorer(b, models.indexOf(b)) - scorer(a, models.indexOf(a));
    return delta || models.indexOf(a) - models.indexOf(b);
  });
}

export function routeAgentModels({
  enabled,
  primaryModel,
  agentModels,
  modelConfig,
  task,
  step,
  history,
}: {
  enabled?: boolean;
  primaryModel: string;
  agentModels?: string[];
  modelConfig?: ModelInfo[] | null;
  task?: string;
  step?: number;
  history?: any[];
}) {
  const models = uniqueModelIds(Array.isArray(agentModels) && agentModels.length > 0
    ? agentModels
    : [primaryModel]);
  if (primaryModel && !models.includes(primaryModel)) models.unshift(primaryModel);

  const assessment = estimateTaskComplexity({ task, step, history });
  if (!enabled || models.length <= 1 || assessment.complexity === 'medium') {
    return { ...assessment, routed: false, models };
  }

  const routed = sortByScore(models, model => {
    const score = scoreModelForRouting(model, modelConfig);
    if (assessment.complexity === 'low') {
      return score.economy * 2 + score.capability * 0.25 + score.context / 100_000;
    }
    return score.capability * 2 + score.context / 100_000 - Math.max(0, score.economy - 50) * 0.2;
  });

  return {
    ...assessment,
    routed: routed.join('\0') !== models.join('\0'),
    models: routed,
  };
}
