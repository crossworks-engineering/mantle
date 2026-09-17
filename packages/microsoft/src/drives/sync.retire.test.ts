/**
 * Guards on the superseded-node cleanup. A re-synced SharePoint file always
 * lands as a NEW node (storeRemoteFileAsNode dedupes on sha256), so the sync
 * has to retire the predecessor or every edit strands one forever — that is
 * how one weekly-edited workbook accreted 47 file nodes and 47 tables.
 *
 * Deleting is irreversible, so the two guards matter more than the happy path:
 * never delete the node the sha256 dedupe just handed back unchanged, and never
 * delete one another drive item still points at.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Rows the mocked `db.select(...).from(...).where(...).limit(1)` chain yields. */
let referrerRows: { id: string }[] = [];

vi.mock('@mantle/db', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(referrerRows),
  };
  return {
    db: { select: () => chain },
    msDriveItems: { nodeId: 'node_id', id: 'id' },
    msDrives: {},
    nodes: {},
  };
});

const deleteFileWithDerived = vi.fn(async () => ({ ok: true as const }));
vi.mock('@mantle/content', () => ({
  deleteFileWithDerived: (...a: unknown[]) => deleteFileWithDerived(...(a as [])),
}));
vi.mock('@mantle/files', () => ({ MAX_UPLOAD_BYTES: 1 }));
vi.mock('../token-store', () => ({ getValidAccessToken: async () => null }));
vi.mock('../client', () => ({
  graphFetchRaw: async () => null,
  graphGetAll: async () => ({ items: [], deltaLink: null }),
}));
vi.mock('./scope', () => ({ listScopes: async () => [] }));
vi.mock('./store', () => ({
  storeRemoteFileAsNode: async () => ({ nodeId: 'x', sha256: '', deduped: false }),
}));

import { retireSupersededNode } from './sync';

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002';

beforeEach(() => {
  referrerRows = [];
  deleteFileWithDerived.mockClear();
  deleteFileWithDerived.mockResolvedValue({ ok: true as const });
});

describe('retireSupersededNode', () => {
  it('retires the predecessor when nothing else references it', async () => {
    expect(await retireSupersededNode('o1', OLD, NEW)).toBe(1);
    expect(deleteFileWithDerived).toHaveBeenCalledWith('o1', OLD);
  });

  it('never deletes when the dedupe returned the SAME node (bytes reverted)', async () => {
    expect(await retireSupersededNode('o1', OLD, OLD)).toBe(0);
    expect(deleteFileWithDerived).not.toHaveBeenCalled();
  });

  it('never deletes a node another drive item still maps to', async () => {
    referrerRows = [{ id: 'some-other-mapping' }];
    expect(await retireSupersededNode('o1', OLD, NEW)).toBe(0);
    expect(deleteFileWithDerived).not.toHaveBeenCalled();
  });

  it('counts a refusal (email attachment, in-use drawing) as not retired', async () => {
    deleteFileWithDerived.mockResolvedValue({ ok: false, reason: 'attachment' } as never);
    expect(await retireSupersededNode('o1', OLD, NEW)).toBe(0);
  });

  it('swallows a thrown error rather than aborting the sync run', async () => {
    deleteFileWithDerived.mockRejectedValue(new Error('boom') as never);
    await expect(retireSupersededNode('o1', OLD, NEW)).resolves.toBe(0);
  });
});
