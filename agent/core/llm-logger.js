/**
 * LLM Logger — 将 LLM 请求/响应日志按模型、按日期写入文件
 *
 * 文件结构：data/llm-logs/2026-04-24/minimaxai_minimax-m2.7.jsonl
 * 每行一个 JSON 对象：{ time, type, model, ... }
 *
 * 调用场景：
 *   - planner.js 发送 NVIDIA API 请求前后
 *   - ai-client.js 发送 Claude API 请求前后
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../helpers/logger.js';

let logDir = process.env.LLM_LOG_DIR || '';

export function initLlmLogger(baseDir) {
  logDir = join(baseDir, 'llm-logs');
}

function getLogDir() {
  return logDir || process.env.LLM_LOG_DIR || join(process.cwd(), 'data/llm-logs');
}

function todayDir() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(getLogDir(), date);
}

function modelFileName(model) {
  return model.replace(/[/\\]/g, '_') + '.jsonl';
}

function timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

const writeQueue = new Map();

async function flushLog(filePath, lines) {
  try {
    await mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true });
    await appendFile(filePath, lines.join('\n') + '\n');
  } catch {
    // best effort
  }
}

function enqueueLog(filePath, line) {
  if (!writeQueue.has(filePath)) {
    writeQueue.set(filePath, []);
    setTimeout(() => {
      const pending = writeQueue.get(filePath);
      writeQueue.delete(filePath);
      flushLog(filePath, pending);
    }, 100);
  }
  writeQueue.get(filePath).push(line);
}

export function logLlmRequest(model, messages) {
  const line = JSON.stringify({ time: timeStr(), type: 'request', model, messages });
  enqueueLog(join(todayDir(), modelFileName(model)), line);
  log.debug(`[LLM] → ${model} messages=${messages.length}`);
}

export function logLlmResponse(model, response) {
  const usage = response.usage || {};
  const line = JSON.stringify({ time: timeStr(), type: 'response', model, usage, response });
  enqueueLog(join(todayDir(), modelFileName(model)), line);
  const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0);
  log.debug(`[LLM] ← ${model} tokens=${tokens}`);
}
