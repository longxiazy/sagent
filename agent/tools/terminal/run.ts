import { spawn } from 'node:child_process';
import path from 'node:path';
import { SAFE_COMMANDS, getFirstToken } from './safe-policy';

type TerminalOutputEvent = {
  phase: 'start' | 'stdout' | 'stderr' | 'exit' | 'error' | 'timeout';
  command: string;
  cwd: string;
  timestamp?: number;
  chunk?: string;
  exitCode?: number | null;
  elapsedMs?: number;
  message?: string;
};

type TerminalActionOptions = {
  cwd?: string | null;
  onOutput?: (event: TerminalOutputEvent) => void;
};

function resolveCwd(value, base = process.cwd()) {
  if (typeof value !== 'string' || !value.trim()) {
    return base;
  }
  return path.isAbsolute(value) ? value : path.resolve(base, value);
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
    /\s&(\s|$)/.test(command) ||
    /&&|\|\|/.test(command) ||
    /[<>]\(/.test(command) ||
    /<<\s*\w/.test(command)
  ) {
    throw new Error(`run_safe 不允许使用危险操作符: ${command}`);
  }
}

function emitTerminalEvent(onOutput: TerminalActionOptions['onOutput'], event: TerminalOutputEvent) {
  if (typeof onOutput !== 'function') return;
  try {
    onOutput(event);
  } catch {
    // Streaming terminal progress is best-effort; command execution should continue.
  }
}

async function runShellCommand(command, { cwd, timeoutMs, onOutput }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    emitTerminalEvent(onOutput, {
      phase: 'start',
      command,
      cwd,
      timestamp: startedAt,
    });

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
      // 后台进程（& 结尾）或长驻服务永远不会退出，给模型可操作建议
      const isBackgroundCmd = /&\s*$/.test(command) || /\bserver\b|\bdaemon\b|\bserve\b/i.test(command);
      const hint = isBackgroundCmd
        ? '。该命令为后台/长驻进程，不会自行退出。建议使用 notify_user 告知用户手动执行，或改用不需要服务器的方案。'
        : '';
      emitTerminalEvent(onOutput, {
        phase: 'timeout',
        command,
        cwd,
        elapsedMs: Date.now() - startedAt,
        message: `命令执行超时 (${timeoutMs} ms)${hint}`,
      });
      reject(new Error(`命令执行超时 (${timeoutMs} ms)${hint}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      emitTerminalEvent(onOutput, {
        phase: 'stdout',
        command,
        cwd,
        chunk: text.slice(0, 4000),
      });
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      emitTerminalEvent(onOutput, {
        phase: 'stderr',
        command,
        cwd,
        chunk: text.slice(0, 4000),
      });
    });

    child.on('error', err => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      emitTerminalEvent(onOutput, {
        phase: 'error',
        command,
        cwd,
        elapsedMs: Date.now() - startedAt,
        message: err.message || String(err),
      });
      reject(err);
    });

    child.on('close', code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      emitTerminalEvent(onOutput, {
        phase: 'exit',
        command,
        cwd,
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
      });
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

export async function executeTerminalAction(action, opts: TerminalActionOptions = {}) {
  const command = action.command || '';
  // 命中项目用项目 rootPath 作为默认 cwd，否则回退 process.cwd()（无项目态，旧行为）。
  const base = opts?.cwd || process.cwd();
  const cwd = resolveCwd(action.cwd, base);
  const timeoutMs = action.timeoutMs || 8000;

  if (!command) {
    throw new Error('终端动作缺少 command');
  }

  if (action.type === 'run_safe') {
    assertSafeCommand(command);
    return runShellCommand(command, { cwd, timeoutMs, onOutput: opts.onOutput });
  }

  if (action.type === 'run_confirmed' || action.type === 'run_review') {
    return runShellCommand(command, { cwd, timeoutMs: Math.max(timeoutMs, 12000), onOutput: opts.onOutput });
  }

  throw new Error(`不支持的终端动作: ${action.type}`);
}
