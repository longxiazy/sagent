import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMemory } from '../agent/core/memory.ts';
import { persistRecoveredAgentRunMemory } from '../routes/agent-run-memory-persist.ts';
import type { ProviderRegistry } from '../agent/core/providers/registry.ts';

let tmpDir = '';

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('recovered run memory', () => {
  it('extracts knowledge without storing the recovered conversation', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-recovered-memory-'));
    const registry = { resolve() { throw new Error('summary model should not be used'); } } as unknown as ProviderRegistry;

    await persistRecoveredAgentRunMemory({
      memoryDir: tmpDir,
      task: '恢复后的项目任务',
      result: { answer: '已更新 src/index.ts 的恢复逻辑', steps: [
        {
          step: 1,
          rationale: '读取入口文件',
          action: { tool: 'fs', type: 'read_file', path: '/src/index.ts', maxBytes: 1000 },
          result: 'file contents',
        },
      ] },
      model: 'test-model',
      registry,
    });

    const memory = await loadMemory(tmpDir);
    expect('conversation' in memory).toBe(false);
    expect(memory.projectKnowledge.paths.index).toBe('/src/index.ts');
  });
});
