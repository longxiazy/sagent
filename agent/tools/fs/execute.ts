import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function resolveInputPath(rawPath, cwd = process.cwd()) {
  if (!rawPath || rawPath === '.') {
    return cwd;
  }
  return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(cwd, rawPath);
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

function assertWithinSandbox(targetPath, sandboxPath) {
  const normalized = path.normalize(targetPath);
  const sandbox = path.normalize(sandboxPath);
  if (!normalized.startsWith(sandbox + path.sep) && normalized !== sandbox) {
    throw new Error(`路径越界，禁止写入 sandbox 之外: ${targetPath}`);
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

function assertSafePath(targetPath) {
  const normalized = path.normalize(targetPath);
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`禁止写入敏感路径: ${targetPath}`);
    }
  }
}

export async function executeFsAction(action, opts: { cwd?: string | null } = {}) {
  // 文件工具根：命中项目用项目 rootPath，否则回退 process.cwd()（无项目态，旧行为）。
  const baseCwd = opts?.cwd || process.cwd();

  if (action.type === 'list_dir') {
    const targetPath = resolveInputPath(action.path, baseCwd);
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const summary = entries
      .slice(0, 40)
      .map(entry => `${formatFileType(entry)} ${entry.name}`)
      .join('\n');
    return summary
      ? `目录 ${targetPath} 包含:\n${summary}`
      : `目录 ${targetPath} 为空`;
  }

  if (action.type === 'read_file') {
    const targetPath = resolveInputPath(action.path, baseCwd);
    assertSafePath(targetPath);
    const buffer = await fs.readFile(targetPath);
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, action.maxBytes || 12000));
    return `文件 ${targetPath} 内容预览:\n${text}`;
  }

  if (action.type === 'write_file') {
    const sandbox = baseCwd;
    const targetPath = resolveInputPath(action.path, sandbox);
    assertWithinSandbox(targetPath, sandbox);
    assertSafePath(targetPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (action.append) {
      await fs.appendFile(targetPath, action.content, 'utf8');
      return `已追加写入文件 ${targetPath}`;
    }
    await fs.writeFile(targetPath, action.content, 'utf8');
    return `已写入文件 ${targetPath}`;
  }

  if (action.type === 'search_files') {
    const targetPath = resolveInputPath(action.path, baseCwd);
    const query = action.query || '';
    if (!query) {
      throw new Error('search_files 缺少 query');
    }
    const maxResults = action.maxResults || 20;
    const include = action.include || '*';
    const args = ['-rn', '--color=never', '-E', query, '--include', include, targetPath];

    const lines = await new Promise<string[]>((resolve, reject) => {
      const proc = spawn('grep', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const collected: string[] = [];
      let buf = '';
      const timer = setTimeout(() => {
        proc.kill();
        resolve(collected);
      }, 10000);

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
        if (buf) collected.push(buf);
        if (code === 1 && collected.length === 0) {
          resolve([]);
        } else {
          resolve(collected);
        }
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
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