import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModelTools } from '../agent/core/tool-definitions.ts';
import { normalizeDesktopAgentDecision } from '../agent/core/schemas.ts';
import { classifyAgentAction } from '../agent/policy/classify.ts';
import { executeFsAction } from '../agent/tools/fs/execute.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-fs-tool-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('FS tool exposure', () => {
  it('exposes get_file_info in model tools', () => {
    const names = createModelTools().map(tool => tool.name);

    expect(names).toContain('get_file_info');
  });
});

describe('FS action normalization', () => {
  it('normalizes get_file_info payloads', () => {
    const result = normalizeDesktopAgentDecision({
      action: {
        type: 'get_file_info',
        path: ' README.md ',
      },
    });

    expect(result.action).toEqual({
      tool: 'fs',
      type: 'get_file_info',
      path: 'README.md',
    });
  });
});

describe('FS policy classification', () => {
  it('treats get_file_info as safe', () => {
    const result = classifyAgentAction({
      tool: 'fs',
      type: 'get_file_info',
      path: 'README.md',
    });

    expect(result.level).toBe('safe');
  });
});

describe('FS action execution', () => {
  it('returns metadata without reading file content', async () => {
    const filePath = path.join(tmpDir, 'sample.txt');
    await fs.writeFile(filePath, 'secret content', 'utf8');

    const result = await executeFsAction({ type: 'get_file_info', path: 'sample.txt' }, { cwd: tmpDir });
    const info = JSON.parse(result.replace(/^文件信息:\n/, ''));

    expect(info.path).toBe(await fs.realpath(filePath));
    expect(info.type).toBe('file');
    expect(info.sizeBytes).toBe(14);
    expect(info.modifiedAt).toEqual(expect.any(String));
    expect(result).not.toContain('secret content');
  });

  it('rejects absolute paths even when they point inside the project', async () => {
    const filePath = path.join(tmpDir, 'sample.txt');
    await fs.writeFile(filePath, 'content', 'utf8');

    await expect(executeFsAction({ type: 'read_file', path: filePath }, { cwd: tmpDir }))
      .rejects.toThrow('禁止使用绝对路径');
  });

  it('rejects relative traversal outside the canonical project root', async () => {
    await expect(executeFsAction({ type: 'read_file', path: '../outside.txt' }, { cwd: tmpDir }))
      .rejects.toThrow('路径越界');
  });

  it('rejects read and write access through symlinks that escape the project', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-fs-outside-'));
    try {
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret', 'utf8');
      await fs.symlink(outsideDir, path.join(tmpDir, 'escape'));

      await expect(executeFsAction({ type: 'read_file', path: 'escape/secret.txt' }, { cwd: tmpDir }))
        .rejects.toThrow('路径越界');
      await expect(executeFsAction({ type: 'write_file', path: 'escape/new.txt', content: 'x' }, { cwd: tmpDir }))
        .rejects.toThrow('路径越界');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('uses canonical paths for symlinks that remain inside the project', async () => {
    await fs.mkdir(path.join(tmpDir, 'real'));
    await fs.writeFile(path.join(tmpDir, 'real', 'inside.txt'), 'inside', 'utf8');
    await fs.symlink(path.join(tmpDir, 'real'), path.join(tmpDir, 'linked'));

    const result = await executeFsAction({ type: 'read_file', path: 'linked/inside.txt' }, { cwd: tmpDir });
    expect(result).toContain(path.join(tmpDir, 'real', 'inside.txt'));
    expect(result).toContain('inside');
  });

  it('reads controlled @uploads paths from the project data directory', async () => {
    const dataDir = path.join(tmpDir, '.data');
    await fs.mkdir(path.join(dataDir, 'uploads', '2026-01-01'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'uploads', '2026-01-01', 'note.txt'), 'attachment', 'utf8');

    const result = await executeFsAction(
      { type: 'read_file', path: '@uploads/2026-01-01/note.txt' },
      { cwd: tmpDir, dataDir },
    );

    expect(result).toContain('attachment');
    await expect(executeFsAction(
      { type: 'write_file', path: '@uploads/2026-01-01/note.txt', content: 'changed' },
      { cwd: tmpDir, dataDir },
    )).rejects.toThrow('禁止写入 @uploads');
  });
});
