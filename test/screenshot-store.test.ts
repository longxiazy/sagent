import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  scanScreenshots,
  cleanupScreenshots,
  resolveInside,
  isSafeSegment,
} from '../helpers/screenshot-store.ts';

const DAY_MS = 86_400_000;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sagent-shots-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeShot(runId: string, name: string, bytes: number, ageMs = 0) {
  const runDir = path.join(dir, runId);
  await mkdir(runDir, { recursive: true });
  const file = path.join(runDir, name);
  await writeFile(file, Buffer.alloc(bytes, 1));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
  return file;
}

describe('scanScreenshots', () => {
  it('按 run 分组、汇总大小、推导 kind', async () => {
    await writeShot('run-a', 'browser-preview-1.jpg', 100);
    await writeShot('run-a', 'screen-2.png', 200);
    await writeShot('run-b', 'browser-preview-3.jpg', 50);

    const scan = await scanScreenshots(dir);
    expect(scan.total.count).toBe(3);
    expect(scan.total.bytes).toBe(350);
    expect(scan.groups).toHaveLength(2);

    const runA = scan.groups.find(g => g.runId === 'run-a')!;
    expect(runA.count).toBe(2);
    expect(runA.bytes).toBe(300);
    const kinds = runA.files.map(f => f.kind).sort();
    expect(kinds).toEqual(['browser', 'desktop']);
    expect(runA.files[0].url).toMatch(/^\/screenshots\/run-a\//);
  });

  it('目录不存在时返回空结果', async () => {
    const scan = await scanScreenshots(path.join(dir, 'nope'));
    expect(scan).toEqual({ total: { count: 0, bytes: 0 }, groups: [] });
  });

  it('忽略非图片文件', async () => {
    await writeShot('run-a', 'notes.txt', 10);
    await writeShot('run-a', 'screen-1.png', 10);
    const scan = await scanScreenshots(dir);
    expect(scan.total.count).toBe(1);
  });
});

describe('cleanupScreenshots', () => {
  it('按 maxAgeDays 删除过期文件', async () => {
    await writeShot('run-a', 'screen-old.png', 10, 3 * DAY_MS);
    await writeShot('run-a', 'screen-new.png', 10, 0);

    const result = await cleanupScreenshots(dir, { enabled: true, maxAgeDays: 1 });
    expect(result.removedFiles).toBe(1);

    const scan = await scanScreenshots(dir);
    expect(scan.total.count).toBe(1);
    expect(scan.groups[0].files[0].name).toBe('screen-new.png');
  });

  it('按 maxTotalMB 从旧到新删至阈值内', async () => {
    const big = 600 * 1024; // 每张 ~0.586MB,两张 > 1MB
    await writeShot('run-a', 'screen-old.png', big, 2 * DAY_MS);
    await writeShot('run-a', 'screen-new.png', big, 0);

    const result = await cleanupScreenshots(dir, { enabled: true, maxTotalMB: 1 });
    expect(result.removedFiles).toBe(1);

    const scan = await scanScreenshots(dir);
    expect(scan.total.count).toBe(1);
    expect(scan.groups[0].files[0].name).toBe('screen-new.png'); // 删的是旧的
  });

  it('清理后移除空 run 目录', async () => {
    await writeShot('run-a', 'screen-old.png', 10, 3 * DAY_MS);
    await cleanupScreenshots(dir, { enabled: true, maxAgeDays: 1 });
    const entries = await readdir(dir);
    expect(entries).not.toContain('run-a');
  });

  it('两项阈值都无效时不删任何文件', async () => {
    await writeShot('run-a', 'screen-1.png', 10, 5 * DAY_MS);
    const result = await cleanupScreenshots(dir, { enabled: true });
    expect(result.removedFiles).toBe(0);
    expect((await scanScreenshots(dir)).total.count).toBe(1);
  });
});

describe('resolveInside / isSafeSegment', () => {
  it('拒绝路径穿越与非法段', () => {
    expect(resolveInside(dir, '..')).toBeNull();
    expect(resolveInside(dir, 'run-a', '../../etc/passwd')).toBeNull();
    expect(resolveInside(dir, 'a/b')).toBeNull();
    const ok = resolveInside(dir, 'run_1', 'screen-1.png');
    expect(ok).toBe(path.join(path.resolve(dir), 'run_1', 'screen-1.png'));
  });

  it('isSafeSegment', () => {
    expect(isSafeSegment('run_1.jpg-2')).toBe(true);
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('')).toBe(false);
  });
});
