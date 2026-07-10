import type { AgentStep, ResultQuality } from './contracts.ts';

const HIGH_STAKES_TASK_PATTERNS = [
  /医保|社保|公积金|签证|移民|贷款|股票|基金|汇率|合规|法律|法规|政策|许可/,
];

// 任务里明确出现这些词，说明 user 期望基于真实网页内容作答（不是凭模型常识）。
const BROWSE_INTENT_TASK_PATTERNS = [
  /官网|官方|网页|网站|页面|打开.*(网|站|页|链接)|访问.*(网|站|页|链接)|浏览|抓取|爬|开户|注册流程|申请流程|步骤/,
];

const OFFICIAL_HOST_PATTERNS = [
  /\.gov\.cn$/i,
  /\.gov$/i,
  /\.edu\.cn$/i,
  /\.org\.cn$/i,
  /(^|\.)gov\.uk$/i,
  /(^|\.)europa\.eu$/i,
  /(^|\.)xinhuanet\.com$/i,
  /(^|\.)news\.cn$/i,
  /(^|\.)people\.com\.cn$/i,
  /(^|\.)cctv\.com$/i,
  /(^|\.)cctv\.cn$/i,
  /(^|\.)sse\.com\.cn$/i,
  /(^|\.)szse\.cn$/i,
  /(^|\.)bse\.cn$/i,
  /(^|\.)hkex\.com\.hk$/i,
];

const FAILURE_PATTERNS = [
  /执行失败|操作失败|访问失败|导航超时|访问超时|timeout|timed out|404 Not Found|403 Forbidden|already running|反爬|验证码|人机验证|安全验证|滑块|页面内容为空|未找到|不存在|撤稿|删除|rate.?limit|429|请求已中断|Web应用防护|Web安全风险|访问不合规|已阻止访问搜索引擎/i,
];

function textOf(value: any) {
  return value == null ? '' : String(value);
}

function normalizeResultStatus(step: any) {
  const value = typeof step?.resultStatus === 'string'
    ? step.resultStatus
    : (typeof step?.status === 'string' ? step.status : '');
  const status = value.trim().toLowerCase();
  if (status === 'success' || status === 'failed' || status === 'rejected') return status;
  return '';
}

function legacyResultMatchesFailure(result: string) {
  return FAILURE_PATTERNS.some(pattern => pattern.test(result));
}

function stepFailed(step: any) {
  const status = normalizeResultStatus(step);
  if (status) return status === 'failed';
  return legacyResultMatchesFailure(textOf(step?.result));
}

function urlsFromText(text: string) {
  return Array.from(text.matchAll(/https?:\/\/[^\s)\]"'<>，。]+/g)).map(match => match[0]);
}

function hostnameFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function isOfficialHost(hostname: string) {
  return OFFICIAL_HOST_PATTERNS.some(pattern => pattern.test(hostname));
}

function hasOfficialUrl(value: any) {
  const direct = textOf(value);
  return urlsFromText(direct).some(url => isOfficialHost(hostnameFromUrl(url)));
}

function resultHasUsableOfficialContent(step: any) {
  const result = textOf(step?.result);
  const url = textOf(step?.url || step?.action?.url || step?.action?.arguments?.url);
  if (!hasOfficialUrl(url) && !hasOfficialUrl(result)) {
    return false;
  }
  if (stepFailed(step) || legacyResultMatchesFailure(result)) {
    return false;
  }
  return result.trim().length >= 80;
}

export function taskRequiresVerifiedSources(task: string) {
  return HIGH_STAKES_TASK_PATTERNS.some(pattern => pattern.test(task || ''));
}

function taskHasBrowseIntent(task: string) {
  return BROWSE_INTENT_TASK_PATTERNS.some(pattern => pattern.test(task || ''));
}

const BROWSE_TOOLS = new Set(['browser', 'chrome']);

function isBrowseStep(step: any) {
  return BROWSE_TOOLS.has(step?.action?.tool);
}

function browseStepProducedContent(step: any) {
  // 浏览类工具的"成功观测"判定：result 非空、不命中失败模式、且包含 url 或 ≥200 字正文。
  const result = textOf(step?.result);
  if (!result.trim()) return false;
  if (stepFailed(step) || legacyResultMatchesFailure(result)) return false;
  if (/https?:\/\//.test(result) && result.length >= 200) return true;
  return result.length >= 400;
}

export function assessResultQuality({ task, steps = [], answer = '' }: { task: string; steps?: AgentStep[]; answer?: string }): ResultQuality {
  const requiresVerifiedSources = taskRequiresVerifiedSources(task);
  const hasBrowseIntent = taskHasBrowseIntent(task);
  const failureSteps = steps.filter(step => {
    if (step?.action?.type === 'finish') return false;
    // MCP 工具列表的结果会原样回显其它工具的参数名（包含 timeout 等），
    // 不应被当作失败步骤。
    const actionType = step?.action?.type;
    if (actionType === 'chrome_list_tools' || actionType === 'ide_list_tools') return false;
    return stepFailed(step);
  });
  const officialSourceSteps = steps.filter(resultHasUsableOfficialContent);
  const browseSteps = steps.filter(isBrowseStep);
  const productiveBrowseSteps = browseSteps.filter(browseStepProducedContent);
  // browse 类任务被模型用常识"凭空"答完：发起过浏览但没拿到任何实质页面内容。
  const browseIntentWithoutObservation =
    hasBrowseIntent && browseSteps.length > 0 && productiveBrowseSteps.length === 0;
  const answerText = textOf(answer);
  const answerAcknowledgesUnverified = /未能核验|无法核验|未完成核验|未找到官方|无法确认|请以.*为准/.test(answerText);

  let status: ResultQuality['status'] = 'done';
  const reasons: string[] = [];

  if (requiresVerifiedSources && officialSourceSteps.length === 0) {
    status = 'done_unverified';
    reasons.push('高风险或时效性任务未获得可用官方来源');
  }

  if (browseIntentWithoutObservation) {
    if (status === 'done') status = 'done_degraded';
    reasons.push('任务要求基于真实网页内容，但浏览过程未取得任何有效页面观测');
  }

  if (failureSteps.length > 0 && status === 'done') {
    status = 'done_degraded';
    reasons.push(`执行过程中有 ${failureSteps.length} 个失败或异常步骤`);
  } else if (failureSteps.length > 0) {
    reasons.push(`执行过程中有 ${failureSteps.length} 个失败或异常步骤`);
  }

  if (requiresVerifiedSources && officialSourceSteps.length === 0 && !answerAcknowledgesUnverified) {
    reasons.push('最终回答未明确标记未核验风险');
  }

  return {
    status,
    requires_verified_sources: requiresVerifiedSources,
    official_source_steps: officialSourceSteps.map(step => step.step).filter(Boolean),
    failure_steps: failureSteps.map(step => step.step).filter(Boolean),
    unverified: status === 'done_unverified',
    browse_intent_without_observation: browseIntentWithoutObservation,
    degraded: status !== 'done',
    reasons,
  };
}
