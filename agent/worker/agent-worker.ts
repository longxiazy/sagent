const protocolWrite = process.stdout.write.bind(process.stdout);
console.log = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);

function writeProtocol(message: any) {
  protocolWrite(`${JSON.stringify(message)}\n`);
}

function writeProtocolAndWait(message: any) {
  return new Promise<void>(resolve => {
    protocolWrite(`${JSON.stringify(message)}\n`, () => resolve());
  });
}

function createApprovalId() {
  return `worker_approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let flushLlmLogsBeforeExit = async () => {};

function createWorkerApprovalStore() {
  const pending = new Map<string, (decision: string) => void>();
  return {
    request(payload = {}) {
      const approvalId = createApprovalId();
      let settled = false;
      const promise = new Promise<string>(resolve => {
        pending.set(approvalId, decision => {
          if (settled) return;
          settled = true;
          pending.delete(approvalId);
          resolve(decision);
        });
      });
      writeProtocol({ type: 'approval_request', approvalId, payload });
      return { approvalId, promise };
    },
    resolve(approvalId: string, decision: string) {
      const resolve = pending.get(approvalId);
      if (!resolve) return;
      resolve(decision);
    },
    rejectAll() {
      for (const [approvalId, resolve] of pending.entries()) {
        pending.delete(approvalId);
        resolve('reject');
      }
    },
  };
}

function serializeError(err: any) {
  return {
    type: 'error',
    error: err?.message || String(err),
    stack: err?.stack,
  };
}

async function main() {
  await import('dotenv/config');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin });

  let runRecord: any = null;
  const cancelAc = new AbortController();
  const approvalStore = createWorkerApprovalStore();

  const startMessage: any = await new Promise(resolve => {
    const onLine = (line: string) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (message.type !== 'start') return;
      rl.off('line', onLine);
      resolve(message);
    };
    rl.on('line', onLine);
  });

  rl.on('line', line => {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'approval_response') {
      approvalStore.resolve(message.approvalId, message.decision);
      return;
    }
    if (message.type === 'cancel') {
      cancelAc.abort();
      approvalStore.rejectAll();
      return;
    }
    if (message.type === 'rollback' && runRecord) {
      runRecord.pendingRollback = message.targetStep;
    }
  });

  const payload = startMessage.payload || {};
  runRecord = { runId: payload.runId, pendingRollback: null };

  const { createClients } = await import('../core/ai-client.ts');
  const { createProviderRegistry } = await import('../core/providers/registry.ts');
  const { createDesktopAgentRunner } = await import('../desktop/agent.ts');
  const { initLlmLogger, flushLlmLogs } = await import('../core/llm-logger.ts');
  const { configStore } = await import('../core/config-store.ts');
  const { DEFAULT_VISION_MODEL } = await import('../tools/vision/execute.ts');
  flushLlmLogsBeforeExit = flushLlmLogs;

  const memoryDir = payload.memoryDir || process.env.MEMORY_DIR || 'data';
  await configStore.init(memoryDir);
  initLlmLogger(memoryDir);

  const { openai_client, gemini_client } = createClients();
  const registry = createProviderRegistry({ openai_client, gemini_client });
  const modelConfig = Array.isArray(payload.modelConfig) ? payload.modelConfig : [];
  const cfg = configStore.get();
  const runDesktopAgent = createDesktopAgentRunner({
    registry,
    openai_client,
    modelConfig,
    maxSteps: cfg.maxSteps,
    defaultHeadless: payload.headless === true,
    observeDesktop: cfg.observeDesktop,
    modelTimeoutMs: cfg.modelTimeoutSec * 1000,
    staggerDelayMs: cfg.staggerDelaySec * 1000,
    batchSize: cfg.batchSize,
    runStore: null,
    approvalStore,
    checkpointDir: payload.checkpointDir || memoryDir,
    visionModel: payload.visionModel || process.env.VISION_MODEL || DEFAULT_VISION_MODEL,
  });

  const checkpointWriter = {
    saveCheckpoint(data: any) {
      writeProtocol({ type: 'checkpoint', data });
    },
    saveHealthySnapshot(data: any) {
      writeProtocol({ type: 'session_checkpoint_snapshot', data });
    },
  };

  const result = await runDesktopAgent({
    task: payload.task,
    model: payload.model,
    models: Array.isArray(payload.models) ? payload.models : [],
    strategy: payload.strategy || 'race',
    systemPrompt: payload.systemPrompt || '',
    headless: payload.headless === true,
    runId: payload.runId,
    runRecord,
    startedAt: payload.startedAt,
    initialStep: payload.initialStep || 1,
    initialHistory: Array.isArray(payload.initialHistory) ? payload.initialHistory : [],
    conversationHistory: Array.isArray(payload.conversationHistory) ? payload.conversationHistory : [],
    memory: payload.memory !== false,
    onEvent: (event: any) => writeProtocol({ type: 'event', payload: event }),
    cancelSignal: cancelAc.signal,
    projectRoot: payload.projectRoot || null,
    dataDir: payload.dataDir || null,
    checkpointWriter,
  });

  await flushLlmLogsBeforeExit();
  await writeProtocolAndWait({ type: 'result', result });
}

main()
  .then(() => process.exit(0))
  .catch(async err => {
    await flushLlmLogsBeforeExit().catch(() => {});
    await writeProtocolAndWait(serializeError(err)).catch(() => {});
    process.exit(1);
  });
