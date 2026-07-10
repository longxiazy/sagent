import { describe, expect, it } from 'vitest';
import { createApprovalStore } from '../agent/core/approval-store.ts';

describe('approval store', () => {
  it('can register a caller-provided approval id for worker bridges', async () => {
    const store = createApprovalStore();
    const { approvalId, promise } = store.request({
      type: 'approval_required',
      runId: 'run_worker_1',
      step: 1,
      action: { tool: 'terminal', type: 'run_confirmed', command: 'npm test', cwd: '', timeoutMs: 12000 },
    }, 'worker_approval_1');

    expect(approvalId).toBe('worker_approval_1');
    store.resolve('worker_approval_1', 'approve');
    await expect(promise).resolves.toBe('approve');
  });

  it('rejects duplicate caller-provided approval ids', () => {
    const store = createApprovalStore();
    const payload = {
      type: 'approval_required' as const,
      runId: 'run_worker_dup',
      action: { tool: 'terminal' as const, type: 'run_confirmed' as const, command: 'npm test', cwd: '', timeoutMs: 12000 },
    };
    store.request(payload, 'worker_approval_dup');

    expect(() => store.request(payload, 'worker_approval_dup')).toThrow('审批已存在');
  });

  it('lists pending approvals for an active run', () => {
    const store = createApprovalStore();
    store.request({
      type: 'approval_required',
      runId: 'run_abc_123',
      step: 2,
      action: { tool: 'terminal', type: 'run_confirmed', command: 'npm test', cwd: '', timeoutMs: 12000 },
      message: '需要确认',
    }, 'approval_pending_1');
    store.request({
      type: 'approval_required',
      runId: 'run_other_456',
      step: 1,
      action: { tool: 'fs', type: 'write_file', path: 'out.txt', content: 'x', append: false },
      message: 'other',
    }, 'approval_pending_2');

    expect(store.listPendingForRun('run_abc_123')).toEqual([
      {
        type: 'approval_required',
        runId: 'run_abc_123',
        approvalId: 'approval_pending_1',
        step: 2,
        action: { tool: 'terminal', type: 'run_confirmed', command: 'npm test', cwd: '', timeoutMs: 12000 },
        message: '需要确认',
      },
    ]);
    expect(store.getPendingForRun('run_abc_123')?.approvalId).toBe('approval_pending_1');
  });
});
