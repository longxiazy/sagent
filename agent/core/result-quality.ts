const HIGH_STAKES_TASK_PATTERNS = [
  /医保|社保|公积金|签证|移民|贷款|股票|基金|汇率|合规|法律|法规|政策|许可/,
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
  if (FAILURE_PATTERNS.some(pattern => pattern.test(result))) {
    return false;
  }
  return result.trim().length >= 80;
}

export function taskRequiresVerifiedSources(task: string) {
  return HIGH_STAKES_TASK_PATTERNS.some(pattern => pattern.test(task || ''));
}

export function assessResultQuality({ task, steps = [], answer = '' }: { task: string; steps?: any[]; answer?: string }) {
  const requiresVerifiedSources = taskRequiresVerifiedSources(task);
  const failureSteps = steps.filter(step => {
    if (step?.action?.type === 'finish') return false;
    return FAILURE_PATTERNS.some(pattern => pattern.test(textOf(step?.result)));
  });
  const officialSourceSteps = steps.filter(resultHasUsableOfficialContent);
  const answerText = textOf(answer);
  const answerAcknowledgesUnverified = /未能核验|无法核验|未完成核验|未找到官方|无法确认|请以.*为准/.test(answerText);

  let status = 'done';
  const reasons: string[] = [];

  if (requiresVerifiedSources && officialSourceSteps.length === 0) {
    status = 'done_unverified';
    reasons.push('高风险或时效性任务未获得可用官方来源');
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
    degraded: status !== 'done',
    reasons,
  };
}
