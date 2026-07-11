import { describe, expect, it } from 'vitest';
import { classifyAgentAction } from '../agent/policy/classify.ts';
import { canRunSafe, parseSafeCommand } from '../agent/tools/terminal/safe-policy.ts';
import { executeTerminalAction, resolveCommandShell } from '../agent/tools/terminal/run.ts';

describe('terminal run_safe policy', () => {
  it('falls back to a portable shell when zsh is unavailable', () => {
    expect(resolveCommandShell(['/definitely/missing/zsh', '/bin/sh'])).toBe('/bin/sh');
  });

  it.each([
    'pwd',
    'ls -la',
    'rg -n "foo bar" src',
    'git status',
    'git diff',
    'date +%Y-%m-%d',
  ])('allows a read-only command: %s', command => {
    expect(canRunSafe(command)).toBe(true);
  });

  it.each([
    'git reset --hard',
    'git clean -fd',
    'git grep --open-files-in-pager=sh pattern',
    'mkdir output',
    'echo x > file',
    'sed -i backup file',
    'find . -exec sh {} ;',
    'rg --pre sh pattern',
    'sort -o output input',
    'tree -o output.txt',
    'env',
    'hostname changed.example',
    'memory_pressure',
    'date 1234',
    '/bin/pwd',
  ])('rejects a writable or executable command: %s', command => {
    expect(canRunSafe(command)).toBe(false);
  });

  it('parses quoted arguments without invoking a shell', () => {
    expect(parseSafeCommand('rg -n "foo bar" \'src files\'')).toEqual({
      file: 'rg',
      args: ['-n', 'foo bar', 'src files'],
    });
  });

  it('preserves explicit empty argv values', () => {
    expect(parseSafeCommand("rg '' README.md")).toEqual({
      file: 'rg',
      args: ['', 'README.md'],
    });
  });

  it('hardens git against configured external processes', () => {
    const parsed = parseSafeCommand('git diff -- README.md');
    expect(parsed.file).toBe('git');
    expect(parsed.args).toEqual(expect.arrayContaining([
      '-c',
      'core.fsmonitor=false',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      'README.md',
    ]));
    expect(parsed.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PAGER: 'cat',
    });
  });

  it('upgrades an unsafe run_safe action to approval', () => {
    const action: any = {
      tool: 'terminal' as const,
      type: 'run_safe' as const,
      command: 'mkdir output',
      cwd: '',
      timeoutMs: 8000,
    };
    const decision = classifyAgentAction(action);
    expect(decision.level).toBe('confirm');
    expect(action.type).toBe('run_confirmed');
  });

  it('executes quoted argv directly without shell expansion', async () => {
    const result = await executeTerminalAction({
      tool: 'terminal',
      type: 'run_safe',
      command: 'ls "package.json"',
      cwd: '',
      timeoutMs: 2000,
    });
    expect(result).toContain('exit_code: 0');
    expect(result).toContain('command: ls "package.json"');
  });

  it('rejects absolute and traversal paths in safe terminal commands', async () => {
    await expect(executeTerminalAction({
      tool: 'terminal',
      type: 'run_safe',
      command: 'ls /etc',
      cwd: '',
      timeoutMs: 2000,
    })).rejects.toThrow('绝对路径');

    await expect(executeTerminalAction({
      tool: 'terminal',
      type: 'run_safe',
      command: 'ls ../',
      cwd: '',
      timeoutMs: 2000,
    })).rejects.toThrow('路径参数越界');
  });

  it('redacts credentials from terminal output and command metadata', async () => {
    const result = await executeTerminalAction({
      tool: 'terminal',
      type: 'run_confirmed',
      command: 'printf "api_key=super-secret-value"',
      cwd: '',
      timeoutMs: 2000,
    });

    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('super-secret-value');
  });
});
