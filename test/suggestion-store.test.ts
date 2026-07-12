import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSuggestionStore } from '../helpers/suggestion-store.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-suggestions-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('suggestion recent history', () => {
  it('isolates recent suggestions by project', async () => {
    const store = createSuggestionStore(tmpDir);
    await store.recordUse({ title: 'A task', text: 'task for A', projectId: 'project-a' });
    await store.recordUse({ title: 'B task', text: 'task for B', projectId: 'project-b' });
    await store.recordUse({ title: 'Global task', text: 'global task' });

    const projectA = await store.getMerged('en', 'project-a');
    const projectB = await store.getMerged('en', 'project-b');
    const global = await store.getMerged('en');

    expect(projectA.agent[0]?.id).toBe('recent');
    expect(projectA.agent[0]?.items.map(item => item.text)).toEqual(['task for A']);
    expect(projectB.agent[0]?.items.map(item => item.text)).toEqual(['task for B']);
    expect(global.agent[0]?.items.map(item => item.text)).toEqual(['global task']);
  });
});
