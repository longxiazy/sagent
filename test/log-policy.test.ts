import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneLogTreeSync, rotateLogFileSync } from '../helpers/log-policy.ts';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

describe('log size and retention policy', () => {
  it('rotates a file before the configured size would be exceeded', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sagent-log-policy-'));
    dirs.push(dir);
    const file = path.join(dir, 'app.log');
    await fsp.writeFile(file, '12345678');

    rotateLogFileSync(file, 4, 10);

    expect(fs.existsSync(file)).toBe(false);
    expect(await fsp.readFile(`${file}.1`, 'utf8')).toBe('12345678');
  });

  it('removes log files older than the retention period', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sagent-log-retention-'));
    dirs.push(dir);
    const oldFile = path.join(dir, 'old.log');
    const freshFile = path.join(dir, 'fresh.log');
    await Promise.all([fsp.writeFile(oldFile, 'old'), fsp.writeFile(freshFile, 'fresh')]);
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await fsp.utimes(oldFile, oldTime, oldTime);

    pruneLogTreeSync(dir, 1);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });
});
