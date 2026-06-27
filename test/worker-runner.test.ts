import { describe, expect, it } from 'vitest';
import { buildWorkerCommand, getWorkerCancelDelays } from '../agent/worker/runner.ts';

describe('worker runner command', () => {
  it('wraps the worker with sandbox-exec and the run project root', () => {
    const cmd = buildWorkerCommand({
      sandbox: true,
      projectRoot: '/tmp/project-a',
      memoryDir: '/repo/data',
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
      '-D',
      'MEMORY_DIR=/repo/data',
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

describe('worker runner cancellation delays', () => {
  it('uses the default SIGTERM and SIGKILL grace periods', () => {
    expect(getWorkerCancelDelays({})).toEqual({
      terminateAfterMs: 3000,
      killAfterMs: 2000,
    });
  });

  it('allows both cancellation grace periods to be configured', () => {
    expect(getWorkerCancelDelays({
      AGENT_WORKER_CANCEL_GRACE_MS: '25',
      AGENT_WORKER_CANCEL_KILL_GRACE_MS: '50',
    })).toEqual({
      terminateAfterMs: 25,
      killAfterMs: 50,
    });
  });

  it('falls back for invalid cancellation delay values', () => {
    expect(getWorkerCancelDelays({
      AGENT_WORKER_CANCEL_GRACE_MS: '-1',
      AGENT_WORKER_CANCEL_KILL_GRACE_MS: 'bad',
    })).toEqual({
      terminateAfterMs: 3000,
      killAfterMs: 2000,
    });
  });
});
