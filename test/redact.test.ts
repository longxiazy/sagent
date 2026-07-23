import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactSensitiveData, redactText } from '../helpers/redact.ts';
import { flushLlmLogs, initLlmLogger, logLlmRequest } from '../agent/core/llm-logger.ts';

let logRoot = '';

afterEach(async () => {
  if (logRoot) await fs.rm(logRoot, { recursive: true, force: true });
  logRoot = '';
});

describe('sensitive data redaction', () => {
  it('redacts common credentials in text', () => {
    const input = 'Authorization: Bearer abcdefghijklmnop api_key=secret-value token=token-value';
    const output = redactText(input);

    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('token-value');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts nested sensitive fields without mutating the source', () => {
    const source = { headers: { authorization: 'Bearer secret' }, nested: [{ password: 'pass1234' }] };
    const output = redactSensitiveData(source);

    expect(output).toEqual({ headers: { authorization: '[REDACTED]' }, nested: [{ password: '[REDACTED]' }] });
    expect(source.headers.authorization).toBe('Bearer secret');
  });

  it('preserves token usage metrics while still redacting credential tokens', () => {
    const source = {
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80, audio_tokens: 0 },
      },
      input_tokens: 120,
      output_tokens: 30,
      max_tokens: 4096,
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      bearerToken: 'bearer-secret',
    };

    expect(redactSensitiveData(source)).toEqual({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80, audio_tokens: 0 },
      },
      input_tokens: 120,
      output_tokens: 30,
      max_tokens: 4096,
      access_token: '[REDACTED]',
      refresh_token: '[REDACTED]',
      bearerToken: '[REDACTED]',
    });
  });

  it('redacts credentials from persisted LLM logs', async () => {
    logRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-llm-redact-'));
    initLlmLogger(logRoot);
    logLlmRequest('test/model', [{ role: 'user', content: 'token=super-secret-value' }]);
    await flushLlmLogs();

    const dateDirs = await fs.readdir(path.join(logRoot, 'llm-logs'));
    const logFile = path.join(logRoot, 'llm-logs', dateDirs[0], 'test_model.jsonl');
    const content = await fs.readFile(logFile, 'utf8');
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('super-secret-value');
  });

  it('keeps a metrics object shared by two sibling keys (no false cycle)', () => {
    // logLlmResponse 把同一个 usage 对象同时放在顶层和 response.usage，
    // 修复前第二次出现会被 seen 误判为循环而整体 [REDACTED]。
    const usage = { completion_tokens: 30, num_draft_tokens: 40 };
    const source = { usage, response: { choices: [], usage } };
    const output: any = redactSensitiveData(source);

    expect(output.usage).toEqual({ completion_tokens: 30, num_draft_tokens: 40 });
    expect(output.response.usage).toEqual({ completion_tokens: 30, num_draft_tokens: 40 });
  });

  it('still breaks genuine reference cycles', () => {
    const node: any = { name: 'a' };
    node.self = node;
    const output: any = redactSensitiveData(node);

    expect(output.name).toBe('a');
    expect(output.self).toBe('[REDACTED]');
  });

  it('preserves NVIDIA speculative-decoding telemetry fields', () => {
    const source = {
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      nvext: {
        spec_decode: {
          num_speculative_tokens: 4,
          num_draft_tokens: 725,
          num_accepted_tokens: 600,
          num_rejected_tokens: 125,
          acceptance_rate: 0.866,
          accepted_tokens_per_position: [0.86],
        },
        request_throughput: {
          generation_tokens_per_second: 120,
          draft_tokens_per_second: 200,
        },
      },
    };

    expect(redactSensitiveData(source)).toEqual(source);
  });
});
