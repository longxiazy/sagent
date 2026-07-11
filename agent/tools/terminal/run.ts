import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseSafeCommand } from './safe-policy';

type TerminalOutputEvent = {
  phase: 'start' | 'stdout' | 'stderr' | 'exit' | 'error' | 'timeout';
  command: string;
  cwd: string;
  sequence?: number;
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

function emitTerminalEvent(onOutput: TerminalActionOptions['onOutput'], event: TerminalOutputEvent) {
  if (typeof onOutput !== 'function') return;
  try {
    onOutput(event);
  } catch {
    // Streaming terminal progress is best-effort; command execution should continue.
  }
}

async function runProcess({ file, args, env = process.env, command, cwd, timeoutMs, onOutput }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let sequence = 0;
    const emitProgress = (event: Omit<TerminalOutputEvent, 'command' | 'cwd' | 'sequence'>) => {
      sequence += 1;
      emitTerminalEvent(onOutput, {
        command,
        cwd,
        sequence,
        ...event,
      });
    };

    emitProgress({
      phase: 'start',
      timestamp: startedAt,
    });

    const child = spawn(file, args, {
      cwd,
      env,
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
      emitProgress({
        phase: 'timeout',
        elapsedMs: Date.now() - startedAt,
        message: `命令执行超时 (${timeoutMs} ms)${hint}`,
      });
      reject(new Error(`命令执行超时 (${timeoutMs} ms)${hint}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      emitProgress({
        phase: 'stdout',
        chunk: text.slice(0, 4000),
      });
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      emitProgress({
        phase: 'stderr',
        chunk: text.slice(0, 4000),
      });
    });

    child.on('error', err => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      emitProgress({
        phase: 'error',
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
      emitProgress({
        phase: 'exit',
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
    const parsed = parseSafeCommand(command);
    return runProcess({ ...parsed, command, cwd, timeoutMs, onOutput: opts.onOutput });
  }

  if (action.type === 'run_confirmed' || action.type === 'run_review') {
    return runProcess({
      file: '/bin/zsh',
      args: ['-lc', command],
      command,
      cwd,
      timeoutMs: Math.max(timeoutMs, 12000),
      onOutput: opts.onOutput,
    });
  }

  throw new Error(`不支持的终端动作: ${action.type}`);
}
