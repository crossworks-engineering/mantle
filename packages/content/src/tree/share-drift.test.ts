/**
 * Share-drift repairs go in batches (workspaces W4b fix round 1, L5): one
 * short transaction per batch of at most REPAIR_BATCH rows, each with its
 * own heads. The repair itself against a real Postgres is in
 * tree-share.viewer.db.test.ts and embeds-follow.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { REPAIR_BATCH, repairBatches } from './share-drift';

describe('repairBatches', () => {
  it('splits into batches of at most 500 by default, in order', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
    const out = repairBatches(ids);
    expect(REPAIR_BATCH).toBe(500);
    expect(out.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(out.flat()).toEqual(ids);
  });

  it('nothing to repair: no batch; a bad size still makes progress', () => {
    expect(repairBatches([])).toEqual([]);
    expect(repairBatches(['a', 'b'], 0)).toEqual([['a'], ['b']]);
  });
});
