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
  it('records the completed recovered task in project memory', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-recovered-memory-'));
    const registry = { resolve() { throw new Error('summary model should not be used'); } } as unknown as ProviderRegistry;

    await persistRecoveredAgentRunMemory({
      memoryDir: tmpDir,
      task: '恢复后的项目任务',
      result: { answer: '恢复完成', steps: [] },
      model: 'test-model',
      registry,
    });

    const memory = await loadMemory(tmpDir);
    expect(memory.conversation.at(-1)).toMatchObject({
      task: '恢复后的项目任务',
      summary: '恢复完成',
    });
  });
});
