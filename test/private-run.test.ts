import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPrivateRun, withPrivateRun } from '../helpers/private-run.ts';
import { removePrivateRunArtifacts } from '../helpers/private-run-artifacts.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-private-run-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('private run context', () => {
  it('propagates through async work and cannot be disabled by a nested scope', async () => {
    await withPrivateRun(true, async () => {
      await Promise.resolve();
      expect(isPrivateRun()).toBe(true);
      withPrivateRun(false, () => expect(isPrivateRun()).toBe(true));
    });
    expect(isPrivateRun()).toBe(false);
  });

  it('removes only the selected run artifacts', async () => {
    const runId = 'run_private_cleanup';
    const paths = [
      path.join(tmpDir, 'traces', `${runId}.jsonl`),
      path.join(tmpDir, 'session-checkpoints', runId, 'session-healthy-1.json'),
      path.join(tmpDir, 'worker-logs', `${runId}.log`),
      path.join(tmpDir, 'screenshots', runId, 'screen-1.png'),
    ];
    for (const file of paths) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'private');
    }
    const unrelated = path.join(tmpDir, 'worker-logs', 'run_other_value.log');
    await fs.writeFile(unrelated, 'keep');

    await withPrivateRun(true, () => removePrivateRunArtifacts(tmpDir, runId));

    for (const file of paths) {
      await expect(fs.access(file)).rejects.toThrow();
    }
    await expect(fs.readFile(unrelated, 'utf8')).resolves.toBe('keep');
  });
});
