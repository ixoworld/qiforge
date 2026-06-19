import { describe, expect, it } from 'vitest';
import { InMemoryApprovalStore } from './approval-store.js';

describe('InMemoryApprovalStore', () => {
  it('approves a specific blob and recognises only that blob, per thread', async () => {
    const store = new InMemoryApprovalStore();
    await store.approve('t1', 'blob_a');
    expect(await store.isApproved('t1', 'blob_a')).toBe(true);
    expect(await store.isApproved('t1', 'blob_b')).toBe(false);
    expect(await store.isApproved('t2', 'blob_a')).toBe(false);
  });

  it('supersedes a prior approval when a new blob is approved', async () => {
    const store = new InMemoryApprovalStore();
    await store.approve('t1', 'blob_a');
    await store.approve('t1', 'blob_b');
    expect(await store.isApproved('t1', 'blob_a')).toBe(false);
    expect(await store.isApproved('t1', 'blob_b')).toBe(true);
  });

  it('clears a pending approval', async () => {
    const store = new InMemoryApprovalStore();
    await store.approve('t1', 'blob_a');
    await store.clear('t1');
    expect(await store.isApproved('t1', 'blob_a')).toBe(false);
  });
});
