import { describe, it, expect } from 'vitest';
import { createApprovalStore } from '../agent/core/approval-store.ts';

describe('approval-store runId isolation', () => {
  it('rejectAll(runId) only rejects that run, leaving others pending', async () => {
    const store = createApprovalStore();

    const a = store.request({ step: 1 }, 'run_a_1');
    const b = store.request({ step: 1 }, 'run_b_1');

    let aDecision: unknown = null;
    let bDecision: unknown = null;
    a.promise.then(d => { aDecision = d; });
    b.promise.then(d => { bDecision = d; });

    // 取消 run A,只拒 A 的待审批
    store.rejectAll('run_a_1');
    await Promise.resolve();
    await Promise.resolve();

    expect(aDecision).toBe('reject');
    expect(bDecision).toBe(null); // B 仍在等待,未被误杀

    // B 仍可被正常 resolve
    store.resolve(b.approvalId, 'approve');
    expect(await b.promise).toBe('approve');
  });

  it('rejectAll() without runId rejects everything (shutdown fallback)', async () => {
    const store = createApprovalStore();
    const a = store.request({ step: 1 }, 'run_a_1');
    const b = store.request({ step: 1 }, 'run_b_1');

    store.rejectAll();

    expect(await a.promise).toBe('reject');
    expect(await b.promise).toBe('reject');
  });

  it('rejectAll(runId) is a no-op for a run with no pending approvals', async () => {
    const store = createApprovalStore();
    const b = store.request({ step: 1 }, 'run_b_1');
    let bDecision: unknown = null;
    b.promise.then(d => { bDecision = d; });

    store.rejectAll('run_nonexistent');
    await Promise.resolve();

    expect(bDecision).toBe(null);
    store.resolve(b.approvalId, 'approve');
    expect(await b.promise).toBe('approve');
  });
});
