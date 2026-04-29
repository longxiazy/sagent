import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
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
  /^\.env$/i,
  /^\.ssh\//i,
  /^\.git\//i,
  / id_rsa/,
  / id_dsa/,
  / authorized_keys/,
  /^\/home\//i,           // 禁止访问其他用户的 HOME 目录
  /^\/Users\//i,          // 禁止访问 macOS 系统目录
  /^\/root\//i,           // 禁止访问 root HOME
  /\/\.ssh\//i,           // 禁止访问任意 .ssh 子目录
  /\/\.gnupg\//i,         // 禁止访问 GPG 密钥目录
];

function assertSafePath(targetPath) {
  const normalized = path.normalize(targetPath);
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`禁止写入敏感路径: ${targetPath}`);
    }
  }
}

export async function executeFsAction(action) {
  if (action.type === 'list_dir') {
    const targetPath = resolveInputPath(action.path);
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
    const targetPath = resolveInputPath(action.path);
    const buffer = await fs.readFile(targetPath);
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, action.maxBytes || 12000));
    return `文件 ${targetPath} 内容预览:\n${text}`;
  }

  if (action.type === 'write_file') {
    const sandbox = process.cwd();
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
    const targetPath = resolveInputPath(action.path);
    const query = action.query || '';
    if (!query) {
      throw new Error('search_files 缺少 query');
    }
    const maxResults = action.maxResults || 20;
    const include = action.include || '*';
    const args = ['-rn', '--color=never', '-E', query, '--include', include, targetPath];
    try {
      const { stdout } = await execFileAsync('grep', args, {
        maxBuffer: 512 * 1024,
        timeout: 10000,
      });
      const lines = stdout.split('\n').filter(Boolean);
      const truncated = lines.slice(0, maxResults);
      const header = `搜索 "${query}" 在 ${targetPath} (${include})，找到 ${lines.length} 个结果:`;
      if (lines.length > maxResults) {
        return `${header}\n${truncated.join('\n')}\n... (截断，共 ${lines.length} 个结果)`;
      }
      return `${header}\n${truncated.join('\n')}`;
    } catch (err) {
      if (err.code === 1 || (err.stderr && err.stderr === '')) {
        return `搜索 "${query}" 在 ${targetPath} (${include}): 未找到匹配`;
      }
      throw new Error(`搜索失败: ${err.message}`);
    }
  }

  throw new Error(`不支持的文件动作: ${action.type}`);
}