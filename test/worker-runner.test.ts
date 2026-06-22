import { describe, expect, it } from 'vitest';
import { buildWorkerCommand } from '../agent/worker/runner.ts';

describe('worker runner command', () => {
  it('wraps the worker with sandbox-exec and the run project root', () => {
    const cmd = buildWorkerCommand({
      sandbox: true,
      projectRoot: '/tmp/project-a',
      sandboxFile: '/repo/sandbox.sb',
      workerFile: '/repo/agent/worker/agent-worker.ts',
      bunCommand: '/usr/local/bin/bun',
      env: { HOME: '/Users/test' },
    });

    expect(cmd.command).toBe('sandbox-exec');
    expect(cmd.args).toEqual([
      '-f',
      '/repo/sandbox.sb',
      '-D',
      'HOME=/Users/test',
      '-D',
      'PROJECT_DIR=/tmp/project-a',
      '/usr/local/bin/bun',
      '/repo/agent/worker/agent-worker.ts',
    ]);
  });

  it('can run a plain worker without sandbox wrapping', () => {
    const cmd = buildWorkerCommand({
      sandbox: false,
      projectRoot: '/tmp/project-a',
      workerFile: '/repo/agent/worker/agent-worker.ts',
      bunCommand: '/usr/local/bin/bun',
    });

    expect(cmd).toEqual({
      command: '/usr/local/bin/bun',
      args: ['/repo/agent/worker/agent-worker.ts'],
    });
  });
});
