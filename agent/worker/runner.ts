import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCheckpoint, saveHealthySnapshot } from '../core/checkpoint.ts';
import { log } from '../../helpers/logger.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CANCEL_GRACE_MS = 3000;
const DEFAULT_CANCEL_KILL_GRACE_MS = 2000;

function resolveBunCommand(env: Record<string, string | undefined> = process.env) {
  if (env.BUN_BIN) return env.BUN_BIN;
  if (path.basename(process.execPath).includes('bun')) return process.execPath;
  return 'bun';
}

export function buildWorkerCommand({
  sandbox,
  projectRoot,
  memoryDir,
  sandboxFile = path.join(REPO_ROOT, 'sandbox.sb'),
  workerFile = path.join(REPO_ROOT, 'agent/worker/agent-worker.ts'),
  bunCommand = resolveBunCommand(),
  env = process.env,
}: {
  sandbox: boolean;
  projectRoot: string;
  memoryDir?: string;
  sandboxFile?: string;
  workerFile?: string;
  bunCommand?: string;
  env?: Record<string, string | undefined>;
}) {
  if (!sandbox) {
    return { command: bunCommand, args: [workerFile] };
  }
  return {
    command: env.SANDBOX_EXEC || 'sandbox-exec',
    args: [
      '-f',
      sandboxFile,
      '-D',
      `HOME=${env.HOME || ''}`,
      '-D',
      `PROJECT_DIR=${projectRoot}`,
      '-D',
      `MEMORY_DIR=${memoryDir || path.join(REPO_ROOT, 'data')}`,
      bunCommand,
      workerFile,
    ],
  };
}

function writeWorkerMessage(child: any, message: any) {
  if (!child.stdin?.writable) return;
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  } catch {
    // Worker may have exited between a UI action and the bridge write.
  }
}

function errorFromWorker(message: any) {
  const err = new Error(message?.error || 'Agent worker failed') as any;
  if (message?.stack) err.stack = message.stack;
  return err;
}

function tail(text: string, max = 3000) {
  if (!text) return '';
  return text.length > max ? text.slice(text.length - max) : text;
}

function createWorkerLogStream(baseDir: string, runId: string) {
  try {
    const dir = path.join(baseDir, 'worker-logs');
    fs.mkdirSync(dir, { recursive: true });
    return fs.createWriteStream(path.join(dir, `${runId}.log`), { flags: 'a' });
  } catch {
    return null;
  }
}

function envMs(env: Record<string, string | undefined>, name: string, fallback: number) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getWorkerCancelDelays(env: Record<string, string | undefined> = process.env) {
  return {
    terminateAfterMs: envMs(env, 'AGENT_WORKER_CANCEL_GRACE_MS', DEFAULT_CANCEL_GRACE_MS),
    killAfterMs: envMs(env, 'AGENT_WORKER_CANCEL_KILL_GRACE_MS', DEFAULT_CANCEL_KILL_GRACE_MS),
  };
}

export function createSandboxedWorkerAgentRunner({
  memoryDir,
  checkpointDir,
  modelConfig,
  approvalStore,
  visionModel,
  sandbox = true,
  sandboxFile = path.join(REPO_ROOT, 'sandbox.sb'),
  workerFile = path.join(REPO_ROOT, 'agent/worker/agent-worker.ts'),
}: {
  memoryDir: string;
  checkpointDir: string;
  modelConfig: any[];
  approvalStore: any;
  visionModel: string;
  sandbox?: boolean;
  sandboxFile?: string;
  workerFile?: string;
}) {
  async function runWorkerAgent(opts: any) {
    const runId = opts.runId;
    const dataDir = opts.dataDir || checkpointDir || memoryDir;
    const projectRoot = path.resolve(opts.projectRoot || process.cwd());
    const { command, args } = buildWorkerCommand({
      sandbox,
      projectRoot,
      memoryDir,
      sandboxFile,
      workerFile,
    });

    const workerLog = createWorkerLogStream(dataDir, runId);
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        SAGENT_WORKER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pendingPersistence: Promise<any>[] = [];
    let stdoutBuffer = '';
    let stderrText = '';
    let settled = false;
    let childClosed = false;
    let cancelRequested = false;
    let terminateTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const persist = (promise: Promise<any>) => {
      pendingPersistence.push(promise.catch(err => {
        log.warn(`[Worker] persistence failed runId=${runId}: ${err?.message || err}`);
      }));
    };

    const finish = async (fn: () => void) => {
      if (settled) return;
      settled = true;
      await Promise.allSettled(pendingPersistence);
      fn();
    };

    const handleMessage = (message: any) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'event') {
        if (message.payload?.type === 'rollback' && opts.runRecord) {
          opts.runRecord.pendingRollback = null;
          opts.runRecord.rolledBack = true;
        }
        opts.onEvent?.(message.payload);
        return;
      }
      if (message.type === 'checkpoint') {
        persist(saveCheckpoint(dataDir, message.data));
        return;
      }
      if (message.type === 'session_checkpoint_snapshot') {
        persist(saveHealthySnapshot({ ...message.data, dir: dataDir }));
        return;
      }
      if (message.type === 'approval_request') {
        try {
          const { approvalId, promise } = approvalStore.request({
            ...(message.payload || {}),
            runId,
          }, message.approvalId);
          promise.then((decision: string) => {
            writeWorkerMessage(child, { type: 'approval_response', approvalId, decision });
          });
        } catch (err: any) {
          log.warn(`[Worker] approval bridge failed runId=${runId}: ${err?.message || err}`);
          writeWorkerMessage(child, { type: 'approval_response', approvalId: message.approvalId, decision: 'reject' });
        }
        return;
      }
      if (message.type === 'result') {
        finish(() => resolveRun(message.result));
        return;
      }
      if (message.type === 'error') {
        finish(() => rejectRun(errorFromWorker(message)));
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let idx: number;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        const raw = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!raw) continue;
        try {
          handleMessage(JSON.parse(raw));
        } catch {
          workerLog?.write(`[stdout] ${raw}\n`);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText += text;
      stderrText = tail(stderrText, 6000);
      workerLog?.write(text);
    });

    let resolveRun: (value: any) => void = () => {};
    let rejectRun: (err: any) => void = () => {};
    const runPromise = new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });

    const abortHandler = () => {
      if (cancelRequested) return;
      cancelRequested = true;
      writeWorkerMessage(child, { type: 'cancel' });
      const { terminateAfterMs, killAfterMs } = getWorkerCancelDelays();
      terminateTimer = setTimeout(() => {
        if (!childClosed) child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!childClosed) child.kill('SIGKILL');
        }, killAfterMs);
      }, terminateAfterMs);
    };
    opts.cancelSignal?.addEventListener?.('abort', abortHandler, { once: true });

    if (opts.runRecord) {
      opts.runRecord.workerControl = {
        cancel: abortHandler,
        rollback: (targetStep: number) => {
          writeWorkerMessage(child, { type: 'rollback', targetStep });
        },
      };
    }

    child.on('error', err => {
      finish(() => rejectRun(err));
    });

    child.on('close', (code, signal) => {
      childClosed = true;
      if (terminateTimer) clearTimeout(terminateTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.cancelSignal?.removeEventListener?.('abort', abortHandler);
      if (opts.runRecord?.workerControl) {
        opts.runRecord.workerControl = null;
      }
      workerLog?.end();
      if (!settled) {
        const suffix = stderrText ? `\n${tail(stderrText)}` : '';
        finish(() => rejectRun(new Error(`Agent worker exited before result (code=${code}, signal=${signal || 'none'})${suffix}`)));
      }
    });

    log.info(`[Worker] spawn runId=${runId} sandbox=${sandbox} projectRoot=${projectRoot}`);
    writeWorkerMessage(child, {
      type: 'start',
      payload: {
        task: opts.task,
        model: opts.model,
        models: opts.models,
        strategy: opts.strategy,
        systemPrompt: opts.systemPrompt,
        headless: opts.headless,
        runId,
        startedAt: opts.startedAt,
        initialStep: opts.initialStep,
        initialHistory: opts.initialHistory,
        conversationHistory: opts.conversationHistory,
        memory: opts.memory,
        projectRoot,
        dataDir,
        memoryDir,
        checkpointDir: dataDir,
        modelConfig,
        visionModel,
      },
    });

    return runPromise;
  }

  return runWorkerAgent;
}
