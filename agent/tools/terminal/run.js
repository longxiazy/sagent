import { spawn } from 'node:child_process';
import path from 'node:path';

const SAFE_COMMANDS = new Set([
  // 文件查看
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'date',
  'echo',
  'rg',
  'find',
  'which',
  'git',
  'grep',
  // 文件操作（低危，只读或无破坏性）
  'mkdir',
  'touch',
  'cp',
  'rm',       // 需配合危险操作符检查
  'mv',
  'cd',
  'ln',
  'chmod',
  'chown',
  'tar',      // 只读操作
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  'diff',
  'sort',
  'uniq',
  'awk',
  'sed',
  'cut',
  'tr',
  'xargs',
  'tee',
  'less',
  'more',
  'tree',
  'du',
  'df',
  'mount',
  'env',
  'printenv',
  'id',
  'whoami',
  'hostname',
  'uname',
  'ps',
  'top',
  'kill',
  'killall',
  'pkill',
  'pgrep',
  'pidof',
  'watch',
  'nc',
  'curl',
  'wget',
  'jq',
]);

function resolveCwd(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return process.cwd();
  }
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function getFirstToken(command) {
  const match = command.trim().match(/^([^\s]+)/);
  return match ? match[1] : '';
}

function assertSafeCommand(command) {
  const firstToken = getFirstToken(command);
  if (!SAFE_COMMANDS.has(firstToken)) {
    throw new Error(`run_safe 不允许执行该命令: ${firstToken || command}`);
  }

  // Block dangerous shell operators: pipe, semicolon, backticks, command substitution,
  // background &, logical &&/||, process substitution, heredoc
  if (
    /[|;]/.test(command) ||
    /`/.test(command) ||
    /\$\(/.test(command) ||
    /\$\{/.test(command) ||
    /[^&]&[^&]/.test(command) ||
    /&&|\|\|/.test(command) ||
    /[<>]\(/.test(command) ||
    /<<\s*\w/.test(command)
  ) {
    throw new Error(`run_safe 不允许使用危险操作符: ${command}`);
  }
}

async function runShellCommand(command, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('zsh', ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`命令执行超时 (${timeoutMs} ms)`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', err => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const output = [`cwd: ${cwd}`, `command: ${command}`];
      if (stdout.trim()) {
        output.push(`stdout:\n${stdout.trim().slice(0, 12000)}`);
      }
      if (stderr.trim()) {
        output.push(`stderr:\n${stderr.trim().slice(0, 4000)}`);
      }
      output.push(`exit_code: ${code}`);
      resolve(output.join('\n\n'));
    });
  });
}

export async function executeTerminalAction(action) {
  const command = action.command || '';
  const cwd = resolveCwd(action.cwd);
  const timeoutMs = action.timeoutMs || 8000;

  if (!command) {
    throw new Error('终端动作缺少 command');
  }

  if (action.type === 'run_safe') {
    assertSafeCommand(command);
    return runShellCommand(command, { cwd, timeoutMs });
  }

  if (action.type === 'run_confirmed' || action.type === 'run_review') {
    return runShellCommand(command, { cwd, timeoutMs: Math.max(timeoutMs, 12000) });
  }

  throw new Error(`不支持的终端动作: ${action.type}`);
}