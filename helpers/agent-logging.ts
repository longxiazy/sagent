import { cleanText, safeJson } from '../agent/core/utils.ts';
import { inferTool as inferToolFromType } from '../agent/core/action-types.ts';
import { log } from './logger.ts';

export function formatLogTime() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

export function buildAgentMetrics(startedAt, { stepCount = 0, status = 'done' } = {}) {
  return {
    elapsed_ms: Date.now() - startedAt,
    step_count: stepCount,
    status,
  };
}

export function buildSseWriter(res) {
  return payload => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };
}

function summarizeAgentActionForLog(action) {
  if (!action || typeof action !== 'object') {
    return null;
  }

  const base: Record<string, any> = {
    tool: action.tool || inferToolFromType(action.type),
    type: action.type,
  };

  if (action.url) {
    base.url = action.url;
  }
  if (action.elementId) {
    base.elementId = action.elementId;
  }
  if (typeof action.submit === 'boolean') {
    base.submit = action.submit;
  }
  if (typeof action.text === 'string' && action.text) {
    base.text = cleanText(action.text, 120);
  }
  if (typeof action.path === 'string' && action.path) {
    base.path = action.path;
  }
  if (typeof action.command === 'string' && action.command) {
    base.command = cleanText(action.command, 160);
  }
  if (typeof action.app === 'string' && action.app) {
    base.app = action.app;
  }
  if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
    base.x = action.x;
    base.y = action.y;
  }
  if (typeof action.seconds === 'number') {
    base.seconds = action.seconds;
  }
  if (typeof action.answer === 'string' && action.answer) {
    base.answer = cleanText(action.answer, 200);
  }

  return base;
}

export function logAgentEvent(event) {
  const time = formatLogTime();

  if (event.type === 'status') {
    log.debug(
      `[${time}] POST /api/agent status=${event.status} message=${safeJson(event.message)}`
    );
    return;
  }

  if (event.type === 'step' && event.stage === 'observe') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=observe observation=${safeJson({
        title: event.observation?.title,
        url: event.observation?.url,
        text: cleanText(event.observation?.text, 220),
        elements: event.observation?.elements ?? [],
      })}`
    );
    return;
  }

  if (event.type === 'step' && event.stage === 'action') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=action rationale=${safeJson(cleanText(event.rationale, 200))} ` +
        `action=${safeJson(summarizeAgentActionForLog(event.action))}`
    );
    return;
  }

  if (event.type === 'step' && event.stage === 'result') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=result result=${safeJson(cleanText(event.result, 220))}`
    );
    return;
  }

  if (event.type === 'done') {
    log.debug(
      `[${time}] POST /api/agent stage=done answer=${safeJson(cleanText(event.answer, 240))} meta=${safeJson(event.meta)}`
    );
    return;
  }

  if (event.type === 'error') {
    log.debug(
      `[${time}] POST /api/agent stage=error error=${safeJson(event.error)}`
    );
    return;
  }

  if (event.type === 'approval_required') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=approval_required approval_id=${event.approvalId} ` +
        `message=${safeJson(event.message)} action=${safeJson(summarizeAgentActionForLog(event.action))}`
    );
    return;
  }

  if (event.type === 'approval_result') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=approval_result decision=${event.decision} ` +
        `message=${safeJson(event.message)}`
    );
    return;
  }

  if (event.type === 'question_required') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=question_required question=${safeJson(event.message)}`
    );
    return;
  }

  if (event.type === 'user_response') {
    log.debug(
      `[${time}] POST /api/agent step=${event.step} stage=user_response question=${safeJson(event.question)} ` +
        `response=${safeJson(cleanText(event.response, 120))}`
    );
    return;
  }

  if (event.type === 'notification') {
    log.debug(
      `[${time}] POST /api/agent notification level=${event.level} message=${safeJson(cleanText(event.message, 200))}`
    );
    return;
  }
}
