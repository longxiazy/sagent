import type { Request } from 'express';

// 后端「面向用户提示」的轻量 i18n。
// 仅覆盖会直接回给前端展示的错误/状态消息；LLM 系统提示词、工具定义、
// Agent 内部推理等不在此列（翻译会改变模型行为）。
// 语言来源：前端 apiFetch 注入的 X-Lang 头优先，其次 Accept-Language，默认中文。

export type Locale = 'zh' | 'en';

const MESSAGES: Record<Locale, Record<string, string>> = {
  zh: {
    'trace.notFound': 'trace 不存在',
    'memory.compacted': '已压缩，保留 {n} 条',
    'memory.noData': '无记忆数据',
    'config.validationFailed': '配置校验失败',
    'run.taskEmpty': 'task 不能为空',
    'run.modelRequired': '请先选择至少一个模型',
    'run.modelAgentIncompatible': '以下模型不适合运行 Desktop Agent：{models}',
    'run.alreadyRunning': '已有 Agent 在运行中，请等待完成或取消',
    'run.notFound': '运行不存在',
    'run.preparing': '准备启动桌面 Agent',
    'approval.runIdEmpty': 'runId 不能为空',
    'approval.approvalIdEmpty': 'approvalId 不能为空',
    'approval.decisionInvalid': 'decision 必须是 approve 或 reject',
    'approval.responseMustBeString': 'response 必须是字符串',
    'checkpoint.targetStepInvalid': 'targetStep 必须是正整数',
    'checkpoint.notEnabled': '会话检查点未启用',
    'checkpoint.noActiveRun': '没有活跃的运行',
    'checkpoint.rollbackInProgress': '已有回滚请求处理中',
    'fetchRules.notEnabled': 'Domain rules 未启用',
    'fetchRules.domainEmpty': 'domain 不能为空',
    'suggestions.textEmpty': 'text 不能为空',
    'suggestions.recent': '最近使用',
  },
  en: {
    'trace.notFound': 'trace not found',
    'memory.compacted': 'Compacted, kept {n} entries',
    'memory.noData': 'No memory data',
    'config.validationFailed': 'Config validation failed',
    'run.taskEmpty': 'task cannot be empty',
    'run.modelRequired': 'Select at least one model first',
    'run.modelAgentIncompatible': 'These models are not compatible with the Desktop Agent: {models}',
    'run.alreadyRunning': 'An Agent is already running; wait for it to finish or cancel it',
    'run.notFound': 'Run not found',
    'run.preparing': 'Preparing to start the desktop Agent',
    'approval.runIdEmpty': 'runId cannot be empty',
    'approval.approvalIdEmpty': 'approvalId cannot be empty',
    'approval.decisionInvalid': 'decision must be approve or reject',
    'approval.responseMustBeString': 'response must be a string',
    'checkpoint.targetStepInvalid': 'targetStep must be a positive integer',
    'checkpoint.notEnabled': 'Session checkpoints are not enabled',
    'checkpoint.noActiveRun': 'No active run',
    'checkpoint.rollbackInProgress': 'A rollback request is already in progress',
    'fetchRules.notEnabled': 'Domain rules are not enabled',
    'fetchRules.domainEmpty': 'domain cannot be empty',
    'suggestions.textEmpty': 'text cannot be empty',
    'suggestions.recent': 'Recent',
  },
};

// 解析请求语言：X-Lang（前端显式传入）→ Accept-Language → 默认 zh。
export function pickLocale(req: Request): Locale {
  const xlang = String(req.headers['x-lang'] ?? '').toLowerCase();
  if (xlang === 'zh' || xlang === 'en') {
    return xlang;
  }
  const accept = String(req.headers['accept-language'] ?? '').toLowerCase();
  if (accept.includes('zh')) return 'zh';
  if (accept.includes('en')) return 'en';
  return 'zh';
}

// 取译文 + {var} 插值。缺失的 key 回退中文，再回退 key 本身。
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = MESSAGES[locale] || MESSAGES.zh;
  let str = dict[key] ?? MESSAGES.zh[key] ?? key;
  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match));
  }
  return str;
}

// 便捷：直接按请求语言取译文。
export function tReq(req: Request, key: string, vars?: Record<string, string | number>): string {
  return t(pickLocale(req), key, vars);
}
