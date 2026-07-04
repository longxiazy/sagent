import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushLlmLogs, initLlmLogger, logLlmResponse } from '../agent/core/llm-logger.ts';

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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
