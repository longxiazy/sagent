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

    expect(info.path).toBe(filePath);
    expect(info.type).toBe('file');
    expect(info.sizeBytes).toBe(14);
    expect(info.modifiedAt).toEqual(expect.any(String));
    expect(result).not.toContain('secret content');
  });
});
