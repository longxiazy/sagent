import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { throwIfAborted } from '../../core/abort.ts';

const execFileAsync = promisify(execFile);

function resolveInputPath(rawPath, cwd = process.cwd()) {
  if (!rawPath || rawPath === '.') {
    return cwd;
  }
  if (path.isAbsolute(rawPath)) {
    throw new Error(`禁止使用绝对路径: ${rawPath}`);
  }
  return path.resolve(cwd, rawPath);
}

function formatFileType(dirent) {
  if (dirent.isDirectory()) {
    return 'dir';
  }
  if (dirent.isSymbolicLink()) {
    return 'symlink';
  }
  return 'file';
}

function formatStatsType(stats) {
  if (stats.isDirectory()) return 'dir';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isBlockDevice()) return 'block_device';
  if (stats.isCharacterDevice()) return 'character_device';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isSocket()) return 'socket';
  return 'other';
}

function assertWithinSandbox(targetPath, sandboxPath, operation = '访问') {
  const relative = path.relative(sandboxPath, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`路径越界，禁止${operation}项目目录之外: ${targetPath}`);
  }
}

const DANGEROUS_PATTERNS = [
  /^\.env(\.\w+)?$/i,
  /^\.ssh\//i,
  /^\.git\//i,
  / id_rsa/,
  / id_dsa/,
  / authorized_keys/,
];

function assertSafePath(targetPath, sandboxPath) {
  const normalized = path.relative(sandboxPath, targetPath);
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`禁止访问敏感路径: ${targetPath}`);
    }
  }
}

export async function executeFsAction(action, opts: { cwd?: string | null; dataDir?: string | null; signal?: AbortSignal } = {}) {
  // 文件工具根：命中项目用项目 rootPath，否则回退 process.cwd()（无项目态，旧行为）。
  const baseCwd = await fs.realpath(opts?.cwd || process.cwd());
  throwIfAborted(opts.signal);

  const resolveRoot = async rawPath => {
    const value = String(rawPath || '.');
    if (!value.startsWith('@uploads/')) {
      return { sandboxRoot: baseCwd, relativePath: value, virtual: false };
    }
    if (!opts.dataDir) throw new Error('当前会话没有附件数据目录');
    const uploadsRoot = await fs.realpath(path.join(opts.dataDir, 'uploads'));
    return {
      sandboxRoot: uploadsRoot,
      relativePath: value.slice('@uploads/'.length),
      virtual: true,
    };
  };

  const resolveExisting = async (rawPath, operation = '访问') => {
    const { sandboxRoot, relativePath } = await resolveRoot(rawPath);
    const lexicalPath = resolveInputPath(relativePath, sandboxRoot);
    assertWithinSandbox(lexicalPath, sandboxRoot, operation);
    assertSafePath(lexicalPath, sandboxRoot);
    const canonicalPath = await fs.realpath(lexicalPath);
    assertWithinSandbox(canonicalPath, sandboxRoot, operation);
    assertSafePath(canonicalPath, sandboxRoot);
    return { lexicalPath, canonicalPath };
  };

  const resolveWriteTarget = async rawPath => {
    const root = await resolveRoot(rawPath);
    if (root.virtual) throw new Error('禁止写入 @uploads 附件目录');
    const lexicalPath = resolveInputPath(rawPath, baseCwd);
    assertWithinSandbox(lexicalPath, baseCwd, '写入');
    assertSafePath(lexicalPath, baseCwd);

    let existingAncestor = lexicalPath;
    while (true) {
      try {
        await fs.lstat(existingAncestor);
        break;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) throw err;
        existingAncestor = parent;
      }
    }
    const canonicalAncestor = await fs.realpath(existingAncestor);
    assertWithinSandbox(canonicalAncestor, baseCwd, '写入');

    await fs.mkdir(path.dirname(lexicalPath), { recursive: true });
    const canonicalParent = await fs.realpath(path.dirname(lexicalPath));
    assertWithinSandbox(canonicalParent, baseCwd, '写入');
    const canonicalPath = path.join(canonicalParent, path.basename(lexicalPath));
    try {
      const existingTarget = await fs.realpath(lexicalPath);
      assertWithinSandbox(existingTarget, baseCwd, '写入');
      return existingTarget;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      return canonicalPath;
    }
  };

  if (action.type === 'list_dir') {
    const { canonicalPath: targetPath } = await resolveExisting(action.path, '读取');
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const summary = entries
      .slice(0, 40)
      .map(entry => `${formatFileType(entry)} ${entry.name}`)
      .join('\n');
    return summary
      ? `目录 ${targetPath} 包含:\n${summary}`
      : `目录 ${targetPath} 为空`;
  }

  if (action.type === 'get_file_info') {
    const { lexicalPath, canonicalPath: targetPath } = await resolveExisting(action.path, '读取');
    const [stats, lexicalStats] = await Promise.all([fs.stat(targetPath), fs.lstat(lexicalPath)]);
    const info = {
      path: targetPath,
      type: formatStatsType(stats),
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      createdAt: stats.birthtime.toISOString(),
      mode: stats.mode.toString(8),
      symlink: lexicalStats.isSymbolicLink(),
    };
    return `文件信息:\n${JSON.stringify(info, null, 2)}`;
  }

  if (action.type === 'read_file') {
    const { canonicalPath: targetPath } = await resolveExisting(action.path, '读取');
    const buffer = await fs.readFile(targetPath, { signal: opts.signal });
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, action.maxBytes || 12000));
    return `文件 ${targetPath} 内容预览:\n${text}`;
  }

  if (action.type === 'write_file') {
    const targetPath = await resolveWriteTarget(action.path);
    if (action.append) {
      await fs.appendFile(targetPath, action.content, 'utf8');
      return `已追加写入文件 ${targetPath}`;
    }
    await fs.writeFile(targetPath, action.content, 'utf8');
    return `已写入文件 ${targetPath}`;
  }

  if (action.type === 'search_files') {
    const { canonicalPath: targetPath } = await resolveExisting(action.path, '读取');
    const query = action.query || '';
    if (!query) {
      throw new Error('search_files 缺少 query');
    }
    const maxResults = action.maxResults || 20;
    const include = action.include || '*';
    // 递归搜索必须排除敏感文件/目录，否则 grep -r 会读取并回显 read_file 明令禁止的
    // .env / .git / .ssh / 私钥内容，绕过敏感文件防护造成凭据泄露。
    const excludeArgs = [
      '--exclude-dir=.git',
      '--exclude-dir=.ssh',
      '--exclude=.env',
      '--exclude=.env.*',
      '--exclude=id_rsa',
      '--exclude=id_dsa',
      '--exclude=authorized_keys',
    ];
    const args = ['-rn', '--color=never', '-E', ...excludeArgs, query, '--include', include, targetPath];

    const lines = await new Promise<string[]>((resolve, reject) => {
      const proc = spawn('grep', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const collected: string[] = [];
      let buf = '';
      const timer = setTimeout(() => {
        proc.kill();
        resolve(collected);
      }, 10000);
      const onAbort = () => {
        clearTimeout(timer);
        proc.kill('SIGTERM');
        reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('Agent 已取消'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line) {
            collected.push(line);
            if (collected.length >= maxResults + 100) {
              clearTimeout(timer);
              proc.kill();
              resolve(collected);
            }
          }
        }
      });

      proc.stderr.on('data', () => {});

      proc.on('close', (code: number) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (buf) collected.push(buf);
        if (code === 1 && collected.length === 0) {
          resolve([]);
        } else {
          resolve(collected);
        }
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });

    if (lines.length === 0) {
      return `搜索 "${query}" 在 ${targetPath} (${include}): 未找到匹配`;
    }

    const truncated = lines.slice(0, maxResults);
    const header = `搜索 "${query}" 在 ${targetPath} (${include})，找到 ${lines.length} 个结果:`;
    if (lines.length > maxResults) {
      return `${header}\n${truncated.join('\n')}\n... (截断，共 ${lines.length} 个结果)`;
    }
    return `${header}\n${truncated.join('\n')}`;
  }

  throw new Error(`不支持的文件动作: ${action.type}`);
}
