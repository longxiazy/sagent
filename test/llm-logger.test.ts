import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushLlmLogs, initLlmLogger, logLlmRequest, logLlmResponse } from '../agent/core/llm-logger.ts';

function todayDirName() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('llm-logger', () => {
  it('flushes queued response logs before the debounce timer fires', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-llm-logger-'));
    try {
      initLlmLogger(dir);
      logLlmResponse('vendor/model', {
        usage: { prompt_tokens: 1, completion_tokens: 2 },
        choices: [],
      });

      await flushLlmLogs();

      const file = path.join(dir, 'llm-logs', todayDirName(), 'vendor_model.jsonl');
      const raw = await readFile(file, 'utf8');
      expect(raw).toContain('"type":"response"');
      expect(raw).toContain('"model":"vendor/model"');
      expect(raw).toContain('"prompt_tokens":1');
      expect(raw).toContain('"completion_tokens":2');
      expect(raw).not.toContain('"prompt_tokens":"[REDACTED]"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records native tool definitions as a tools pseudo-message in the request log', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-llm-logger-tools-'));
    try {
      initLlmLogger(dir);
      logLlmRequest('vendor/model', [{ role: 'user', content: 'hi' }], [
        { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
      ]);

      await flushLlmLogs();

      const file = path.join(dir, 'llm-logs', todayDirName(), 'vendor_model.jsonl');
      const raw = await readFile(file, 'utf8');
      expect(raw).toContain('"type":"request"');
      expect(raw).toContain('"role":"tools"');
      expect(raw).toContain('"name":"finish"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits the tools pseudo-message when no native tools are sent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-llm-logger-notools-'));
    try {
      initLlmLogger(dir);
      logLlmRequest('vendor/model', [{ role: 'user', content: 'hi' }]);

      await flushLlmLogs();

      const file = path.join(dir, 'llm-logs', todayDirName(), 'vendor_model.jsonl');
      const raw = await readFile(file, 'utf8');
      expect(raw).toContain('"type":"request"');
      expect(raw).not.toContain('"role":"tools"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
