import { describe, expect, it } from 'vitest';
import { createApprovalStore } from '../agent/core/approval-store.ts';

describe('approval store', () => {
  it('can register a caller-provided approval id for worker bridges', async () => {
    const store = createApprovalStore();
    const { approvalId, promise } = store.request({ step: 1 }, 'worker_approval_1');

    expect(approvalId).toBe('worker_approval_1');
    store.resolve('worker_approval_1', 'approve');
    await expect(promise).resolves.toBe('approve');
  });

  it('rejects duplicate caller-provided approval ids', () => {
    const store = createApprovalStore();
    store.request({}, 'worker_approval_dup');

    expect(() => store.request({}, 'worker_approval_dup')).toThrow('审批已存在');
  });
});
