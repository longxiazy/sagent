/**
 * LLM Logger — 将 LLM 请求/响应日志按模型、按日期写入文件
 *
 * 文件结构：data/llm-logs/2026-04-24/minimaxai_minimax-m2.7.jsonl
 * 每行一个 JSON 对象：{ time, type, model, ... }
 *
 * 调用场景：
 *   - planner.js 发送 NVIDIA API 请求前后
 *   - provider 调用模型 API 前后
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../helpers/logger.ts';
import { extractErrorDiagnostics, formatErrorDiagnostics } from '../../helpers/retry.ts';
import { getLogPolicy, pruneLogTreeSync, rotateLogFileSync } from '../../helpers/log-policy.ts';
import { redactSensitiveData } from '../../helpers/redact.ts';

let logDir = 'data/llm-logs';

export function initLlmLogger(baseDir) {
  logDir = join(baseDir, 'llm-logs');
  pruneLogTreeSync(logDir, getLogPolicy().retentionDays);
}

function todayDir() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(logDir, date);
}

function modelFileName(model) {
  return model.replace(/[/\\]/g, '_') + '.jsonl';
}

function timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

const writeQueue = new Map();
const flushTimers = new Map();
const activeFlushes = new Set<Promise<void>>();

async function flushLog(filePath, lines) {
  try {
    await mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true });
    const output = lines.join('\n') + '\n';
    const policy = getLogPolicy();
    const buffer = Buffer.from(output);
    const capped = buffer.length > policy.maxBytes ? buffer.subarray(0, policy.maxBytes) : buffer;
    rotateLogFileSync(filePath, capped.length, policy.maxBytes);
    await appendFile(filePath, capped);
  } catch (err: any) {
    log.warn(`[LLM] 日志写入失败 file=${filePath}: ${err?.message || err}`);
  }
}

function enqueueLog(filePath, line) {
  if (!writeQueue.has(filePath)) {
    writeQueue.set(filePath, []);
    flushTimers.set(filePath, setTimeout(() => {
      flushQueuedFile(filePath);
    }, 100));
  }
  writeQueue.get(filePath).push(line);
}

function trackFlush(promise: Promise<void>) {
  activeFlushes.add(promise);
  promise.finally(() => activeFlushes.delete(promise));
  return promise;
}

function flushQueuedFile(filePath) {
  const timer = flushTimers.get(filePath);
  if (timer) clearTimeout(timer);
  flushTimers.delete(filePath);

  const pending = writeQueue.get(filePath);
  writeQueue.delete(filePath);
  if (!pending?.length) return Promise.resolve();
  return trackFlush(flushLog(filePath, pending));
}

export async function flushLlmLogs() {
  do {
    await Promise.all([...writeQueue.keys()].map(flushQueuedFile));
    if (activeFlushes.size > 0) {
      await Promise.allSettled([...activeFlushes]);
    }
  } while (writeQueue.size > 0 || activeFlushes.size > 0);
}

export function logLlmRequest(model, messages, tools = null) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  // tools 是请求的独立字段、不在 messages 里；以 {role:'tools'} 伪消息并入，
  // 让文件日志与前端 trace 用同一套 messages 展示（与 gemini provider 一致）。
  const combined = hasTools ? [...messages, { role: 'tools', content: tools }] : messages;
  const safeMessages = redactSensitiveData(combined);
  const line = JSON.stringify({ time: timeStr(), type: 'request', model, messages: safeMessages });
  enqueueLog(join(todayDir(), modelFileName(model)), line);
  log.debug(`[LLM] → ${model} messages=${messages.length}${hasTools ? ` tools=${tools.length}` : ''}`);
  return safeMessages;
}

export function logLlmResponse(model, response) {
  const usage = response.usage || {};
  const line = JSON.stringify(redactSensitiveData({ time: timeStr(), type: 'response', model, usage, response }));
  enqueueLog(join(todayDir(), modelFileName(model)), line);
  const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0);
  log.debug(`[LLM] ← ${model} tokens=${tokens}`);
}

export function logLlmError(model, err, context = {}) {
  const line = JSON.stringify(redactSensitiveData({ time: timeStr(), type: 'error', model, context, error: extractErrorDiagnostics(err) }));
  enqueueLog(join(todayDir(), modelFileName(model)), line);
  log.warn(`[LLM] ✕ ${model} ${formatErrorDiagnostics(err)}`);
}
