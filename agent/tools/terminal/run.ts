import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseSafeCommand } from './safe-policy';
import { throwIfAborted } from '../../core/abort.ts';
import { redactText } from '../../../helpers/redact.ts';

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
  signal?: AbortSignal;
};

export function resolveCommandShell(
  candidates = [process.env.SAGENT_SHELL, '/bin/zsh', process.env.SHELL, '/bin/bash', '/bin/sh'],
): string {
  return candidates.find(candidate => (
    typeof candidate === 'string'
    && path.isAbsolute(candidate)
    && existsSync(candidate)
  )) || '/bin/sh';
}

async function resolveCwd(value, base = process.cwd()) {
  const canonicalBase = await fs.realpath(base);
  if (typeof value !== 'string' || !value.trim()) {
    return canonicalBase;
  }
  if (path.isAbsolute(value)) throw new Error(`终端 cwd 禁止使用绝对路径: ${value}`);
  const canonicalCwd = await fs.realpath(path.resolve(canonicalBase, value));
  const relative = path.relative(canonicalBase, canonicalCwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`终端 cwd 路径越界: ${value}`);
  }
  return canonicalCwd;
}

async function assertSafeCommandPaths(args: string[], cwd: string) {
  for (const arg of args) {
    const candidate = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!candidate) continue;
    if (candidate.startsWith('-')) {
      // 粘连短选项的路径值（如 -f/etc/passwd）不走上面的 = 分支，单独约束绝对路径/越界。
      const attached = candidate.replace(/^-+[A-Za-z]*/, '');
      if (attached && (path.isAbsolute(attached) || attached.split(/[\\/]/).includes('..'))) {
        throw new Error(`run_safe 路径参数越界: ${attached}`);
      }
      continue;
    }
    if (path.isAbsolute(candidate)) throw new Error(`run_safe 禁止使用绝对路径参数: ${candidate}`);
    const segments = candidate.split(/[\\/]/);
    if (segments.includes('..')) throw new Error(`run_safe 路径参数越界: ${candidate}`);
    try {
      const canonical = await fs.realpath(path.resolve(cwd, candidate));
      const relative = path.relative(cwd, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`run_safe 路径参数越界: ${candidate}`);
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
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

async function runProcess({ file, args, env = process.env, command, cwd, timeoutMs, onOutput, signal }) {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (err) {
      reject(err);
      return;
    }
    const startedAt = Date.now();
    let sequence = 0;
    const emitProgress = (event: Omit<TerminalOutputEvent, 'command' | 'cwd' | 'sequence'>) => {
      sequence += 1;
      emitTerminalEvent(onOutput, {
        command: redactText(command),
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
    // 输出最终只截取前若干字节，累积无上限会在高产出命令超时前占满内存；
    // 达到上限后停止追加（保留已收集的头部内容）。
    const MAX_CAPTURE = 256 * 1024;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }, 1000);
    };
    const onAbort = () => {
      terminate();
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error('Agent 已取消')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      terminate();
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
      finish(() => reject(new Error(`命令执行超时 (${timeoutMs} ms)${hint}`)));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      if (settled) return;
      const text = chunk.toString();
      if (stdout.length < MAX_CAPTURE) stdout += redactText(text);
      emitProgress({
        phase: 'stdout',
        chunk: redactText(text).slice(0, 4000),
      });
    });

    child.stderr.on('data', chunk => {
      if (settled) return;
      const text = chunk.toString();
      if (stderr.length < MAX_CAPTURE) stderr += redactText(text);
      emitProgress({
        phase: 'stderr',
        chunk: redactText(text).slice(0, 4000),
      });
    });

    child.on('error', err => {
      if (settled) {
        return;
      }
      emitProgress({
        phase: 'error',
        elapsedMs: Date.now() - startedAt,
        message: err.message || String(err),
      });
      finish(() => reject(err));
    });

    child.on('close', code => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) {
        return;
      }
      emitProgress({
        phase: 'exit',
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
      });
      const output = [`cwd: ${cwd}`, `command: ${redactText(command)}`];
      if (stdout.trim()) {
        output.push(`stdout:\n${stdout.trim().slice(0, 12000)}`);
      }
      if (stderr.trim()) {
        output.push(`stderr:\n${stderr.trim().slice(0, 4000)}`);
      }
      output.push(`exit_code: ${code}`);
      finish(() => resolve(output.join('\n\n')));
    });
  });
}

export async function executeTerminalAction(action, opts: TerminalActionOptions = {}) {
  const command = action.command || '';
  // 命中项目用项目 rootPath 作为默认 cwd，否则回退 process.cwd()（无项目态，旧行为）。
  const base = opts?.cwd || process.cwd();
  const cwd = await resolveCwd(action.cwd, base);
  const timeoutMs = action.timeoutMs || 8000;

  if (!command) {
    throw new Error('终端动作缺少 command');
  }

  if (action.type === 'run_safe') {
    const parsed = parseSafeCommand(command);
    await assertSafeCommandPaths(parsed.args, cwd);
    return runProcess({ ...parsed, command, cwd, timeoutMs, onOutput: opts.onOutput, signal: opts.signal });
  }

  if (action.type === 'run_confirmed' || action.type === 'run_review') {
    return runProcess({
      file: resolveCommandShell(),
      args: ['-lc', command],
      command,
      cwd,
      timeoutMs: Math.max(timeoutMs, 12000),
      onOutput: opts.onOutput,
      signal: opts.signal,
    });
  }

  throw new Error(`不支持的终端动作: ${action.type}`);
}
