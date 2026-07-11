import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectStore,
  resolveRunPathsForExecution,
} from '../agent/core/project-store.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-project-store-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('project root validation', () => {
  it('stores the canonical directory path', async () => {
    const memoryDir = path.join(tmpDir, 'data');
    const actualRoot = path.join(tmpDir, 'actual-project');
    const linkedRoot = path.join(tmpDir, 'linked-project');
    await fs.mkdir(actualRoot);
    await fs.symlink(actualRoot, linkedRoot);
    const store = createProjectStore(memoryDir);
    await store.init();

    const project = await store.create({ name: 'linked', rootPath: linkedRoot });

    expect(project.rootPath).toBe(await fs.realpath(actualRoot));
  });

  it('rejects missing paths and regular files', async () => {
    const store = createProjectStore(path.join(tmpDir, 'data'));
    await store.init();
    const missing = path.join(tmpDir, 'missing');
    const file = path.join(tmpDir, 'file.txt');
    await fs.writeFile(file, 'not a directory');

    await expect(store.create({ name: 'missing', rootPath: missing }))
      .rejects.toThrow('项目根目录不存在或已移动');
    await expect(store.create({ name: 'file', rootPath: file }))
      .rejects.toThrow('项目根路径不是目录');
  });

  it('rejects execution after a registered project directory is removed', async () => {
    const memoryDir = path.join(tmpDir, 'data');
    const root = path.join(tmpDir, 'project');
    await fs.mkdir(root);
    const store = createProjectStore(memoryDir);
    await store.init();
    const project = await store.create({ name: 'project', rootPath: root });
    await fs.rm(root, { recursive: true, force: true });

    await expect(resolveRunPathsForExecution(store, project.projectId, memoryDir))
      .rejects.toThrow('项目根目录不存在或已移动');
    await expect(store.update(project.projectId, { name: 'renamed' }))
      .rejects.toThrow('项目根目录不存在或已移动');
    await expect(store.setActive(project.projectId))
      .rejects.toThrow('项目根目录不存在或已移动');
  });
});
