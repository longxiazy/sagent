import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadMemory, saveMemory, buildMemoryPrompt, extractProjectKnowledge } from '../agent/core/memory.ts';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-memory-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('knowledge memory', () => {
  it('returns empty project knowledge when no file exists', async () => {
    const memory = await loadMemory(tmpDir);
    expect(memory).toEqual({
      version: 1,
      projectKnowledge: { structure: [], paths: {}, preferences: [], learnings: [] },
    });
  });

  it('drops legacy conversation fields while loading', async () => {
    await fs.writeFile(path.join(tmpDir, 'agent-memory.json'), JSON.stringify({
      conversation: [{ task: 'legacy task', summary: 'legacy result' }],
      conversationSummary: 'legacy summary',
      projectKnowledge: { learnings: ['keep this knowledge'] },
    }));

    const memory = await loadMemory(tmpDir);
    expect('conversation' in memory).toBe(false);
    expect('conversationSummary' in memory).toBe(false);
    expect(memory.projectKnowledge.learnings).toEqual(['keep this knowledge']);
  });

  it('round-trips project knowledge', async () => {
    const memory = await loadMemory(tmpDir);
    memory.projectKnowledge.paths.entry = '/src/index.ts';
    await saveMemory(tmpDir, memory);
    expect((await loadMemory(tmpDir)).projectKnowledge.paths.entry).toBe('/src/index.ts');
  });

  it('injects knowledge but no legacy conversation into the prompt', () => {
    const prompt = buildMemoryPrompt({
      conversation: [{ task: 'do not include', summary: 'legacy' }],
      projectKnowledge: { structure: ['src contains the application'], paths: {}, preferences: [], learnings: [] },
    });
    expect(prompt).toContain('src contains the application');
    expect(prompt).not.toContain('do not include');
  });
});

describe('extractProjectKnowledge', () => {
  it('learns directory structure from list_dir', () => {
    const memory = { projectKnowledge: { structure: [], paths: {}, preferences: [], learnings: [] } };
    extractProjectKnowledge(memory, {
      task: 'list files',
      result: { steps: [{ action: { type: 'list_dir', path: '/src' }, result: 'index.js App.jsx' }] },
    });
    expect(memory.projectKnowledge.structure.length).toBeGreaterThan(0);
  });

  it('learns file paths from read/write', () => {
    const memory = { projectKnowledge: { structure: [], paths: {}, preferences: [], learnings: [] } };
    extractProjectKnowledge(memory, {
      task: 'edit',
      result: { steps: [{ action: { type: 'read_file', path: '/src/utils.js' } }] },
    });
    expect((memory.projectKnowledge as any).paths.utils).toBe('/src/utils.js');
  });
});
