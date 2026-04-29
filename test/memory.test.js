import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadMemory,
  saveMemory,
  compactConversationMemory,
  buildMemoryPrompt,
  extractConversationEntry,
  extractProjectKnowledge,
} from '../agent/core/memory.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-memory-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(task, summary) {
  return { task, summary, timestamp: new Date().toISOString(), model: 'test', filesTouched: [], toolsUsed: [] };
}

describe('loadMemory / saveMemory', () => {
  it('returns empty memory when no file exists', async () => {
    const mem = await loadMemory(tmpDir);
    expect(mem.conversation).toEqual([]);
    expect(mem.conversationSummary).toBe('');
    expect(mem.projectKnowledge).toBeDefined();
  });

  it('round-trips memory to disk', async () => {
    const mem = await loadMemory(tmpDir);
    mem.conversation.push(makeEntry('task A', 'result A'));
    await saveMemory(tmpDir, mem);

    const loaded = await loadMemory(tmpDir);
    expect(loaded.conversation).toHaveLength(1);
    expect(loaded.conversation[0].task).toBe('task A');
  });
});

describe('compactConversationMemory', () => {
  const LIMIT = 5;

  it('does nothing when under limit', async () => {
    const mem = { conversation: [makeEntry('a', 'b')], conversationSummary: '' };
    await compactConversationMemory(mem, { maxEntries: LIMIT });
    expect(mem.conversation).toHaveLength(1);
  });

  it('compacts when over limit', async () => {
    const mem = { conversation: [], conversationSummary: '' };
    for (let i = 0; i < 10; i++) {
      mem.conversation.push(makeEntry(`task ${i}`, `result ${i}`));
    }
    await compactConversationMemory(mem, { maxEntries: LIMIT });
    expect(mem.conversation).toHaveLength(LIMIT);
    expect(mem.conversationSummary).toContain('task 0');
    expect(mem.conversationSummary).toContain('task 9');
  });

  it('truncates summary without summarizeFn', async () => {
    const mem = { conversation: [], conversationSummary: '' };
    for (let i = 0; i < 20; i++) {
      mem.conversation.push(makeEntry(`task ${i} with a longer description`, `result ${i} with details`));
    }
    await compactConversationMemory(mem, { maxEntries: LIMIT });
    expect(mem.conversationSummary.length).toBeLessThanOrEqual(2000);
  });

  it('uses summarizeFn when provided', async () => {
    const mem = { conversation: [], conversationSummary: '' };
    for (let i = 0; i < 10; i++) {
      mem.conversation.push(makeEntry(`task ${i}`, `result ${i}`));
    }
    await compactConversationMemory(mem, {
      maxEntries: LIMIT,
      summarizeFn: async (text) => 'LLM summary: ' + text.slice(0, 50),
    });
    expect(mem.conversation).toHaveLength(LIMIT);
    expect(mem.conversationSummary).toContain('LLM summary');
  });

  it('falls back to concatenation when summarizeFn fails', async () => {
    const mem = { conversation: [], conversationSummary: '' };
    for (let i = 0; i < 10; i++) {
      mem.conversation.push(makeEntry(`task ${i}`, `result ${i}`));
    }
    await compactConversationMemory(mem, {
      maxEntries: LIMIT,
      summarizeFn: async () => { throw new Error('LLM error'); },
    });
    expect(mem.conversation).toHaveLength(LIMIT);
    expect(mem.conversationSummary).toContain('task 0');
  });
});

describe('buildMemoryPrompt', () => {
  it('returns empty string for empty memory', () => {
    const mem = { conversation: [], conversationSummary: '', projectKnowledge: { structure: [], paths: {}, preferences: [], learnings: [] } };
    expect(buildMemoryPrompt(mem)).toBe('');
  });

  it('includes conversation entries', () => {
    const mem = { conversation: [makeEntry('search files', 'found 3 files')], conversationSummary: '', projectKnowledge: {} };
    const prompt = buildMemoryPrompt(mem);
    expect(prompt).toContain('search files');
    expect(prompt).toContain('found 3 files');
  });

  it('respects maxChars limit', () => {
    const mem = { conversation: [], conversationSummary: '', projectKnowledge: {} };
    for (let i = 0; i < 20; i++) {
      mem.conversation.push(makeEntry(`task ${i} `.repeat(10), `result ${i} `.repeat(10)));
    }
    const prompt = buildMemoryPrompt(mem, { maxChars: 200 });
    expect(prompt.length).toBeLessThanOrEqual(210); // allow for truncation + '...'
  });
});

describe('extractConversationEntry', () => {
  it('extracts task and answer', () => {
    const entry = extractConversationEntry({
      task: 'open browser and search',
      result: { answer: 'searched successfully', steps: [] },
      model: 'claude',
    });
    expect(entry.task).toContain('open browser');
    expect(entry.summary).toContain('searched successfully');
    expect(entry.model).toBe('claude');
  });

  it('extracts file paths from steps', () => {
    const entry = extractConversationEntry({
      task: 'edit code',
      result: {
        answer: 'done',
        steps: [
          { action: { tool: 'fs', type: 'write_file', path: '/src/index.js' } },
          { action: { tool: 'terminal', type: 'run_safe', command: 'cat /src/App.jsx' } },
        ],
      },
      model: 'test',
    });
    expect(entry.filesTouched).toContain('/src/index.js');
    expect(entry.filesTouched).toContain('/src/App.jsx');
  });
});

describe('extractProjectKnowledge', () => {
  it('learns directory structure from list_dir', () => {
    const mem = { conversation: [], conversationSummary: '', projectKnowledge: { structure: [], paths: {}, preferences: [], learnings: [] } };
    extractProjectKnowledge(mem, {
      task: 'list files',
      result: { steps: [{ action: { type: 'list_dir', path: '/src' }, result: 'index.js App.jsx' }] },
    });
    expect(mem.projectKnowledge.structure.length).toBeGreaterThan(0);
  });

  it('learns file paths from read/write', () => {
    const mem = { conversation: [], conversationSummary: '', projectKnowledge: { structure: [], paths: {}, preferences: [], learnings: [] } };
    extractProjectKnowledge(mem, {
      task: 'edit',
      result: { steps: [{ action: { type: 'read_file', path: '/src/utils.js' } }] },
    });
    expect(mem.projectKnowledge.paths.utils).toBe('/src/utils.js');
  });
});
