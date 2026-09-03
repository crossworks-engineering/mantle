/**
 * `reconcileEntities` — the edge rebuild.
 *
 * The per-mention matching ladder (exact/alias → trigram → embedding → create)
 * lives in the module-local `reconcileEntity` and is driven here through the db
 * stub: every mention resolves on the cheapest branch, the exact-name match.
 * What these tests pin is the rebuild protocol AROUND that loop, which is where
 * the expensive mistake lives:
 *
 *  - The delete and the insert happen TOGETHER, in one transaction, at the END
 *    — after every network call. The original ordering deleted first, so a
 *    crash while embedding a candidate destroyed the previous extraction's
 *    edges with nothing written to replace them, and the node silently lost its
 *    graph. Edges accumulate in memory during the loop instead.
 *  - It REPLACES rather than appends, in BOTH directions: the inbound
 *    `mentioned_in` edges pointing at this node, and this node's outbound
 *    `references` links. Clear only one and a re-extract doubles the graph.
 *  - One bad mention does not cost the node its whole reconciliation — and a
 *    document that now mentions nobody ends with no edges, not last week's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Rows the next `.limit()` returns, in order. An Error is thrown instead. */
  selectQueue: [] as Array<unknown[] | Error>,
  /** Deletes issued inside the transaction. */
  deletes: [] as unknown[],
  /** Row batches inserted inside the transaction. */
  inserted: [] as unknown[],
  txCalls: 0,
  /** How many deletes had happened when each select ran — proves ordering. */
  deletesDuringSelect: [] as number[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const tx = {
    delete: vi.fn(() => ({
      where: vi.fn(async (clause: unknown) => {
        h.deletes.push(clause);
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (rows: unknown) => {
        h.inserted.push(rows);
      }),
    })),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => {
      h.deletesDuringSelect.push(h.deletes.length);
      const next = h.selectQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    }),
  };
  const db = {
    ...actual.db,
    select: vi.fn(() => selectChain),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      h.txCalls++;
      return fn(tx);
    }),
  };
  return { ...actual, db };
});
vi.mock('@mantle/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }));
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    step: async (_spec: unknown, fn: (handle: unknown) => Promise<unknown>) =>
      fn({ setOutput: vi.fn(), setMeta: vi.fn() }),
  };
});

import { reconcileEntities } from './entities';

const NODE = { id: 'n1', ownerId: 'o1', type: 'note', title: 'T', data: {} } as never;

/** An existing entity row, so the mention resolves on the exact-match branch. */
const entity = (id: string, name: string) => [{ id, name, aliases: [], kind: 'person' }];

/** The edge rows written in the single insert. */
function insertedEdges(): Array<Record<string, unknown>> {
  return (h.inserted[0] as Array<Record<string, unknown>>) ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.deletes.length = 0;
  h.inserted.length = 0;
  h.deletesDuringSelect.length = 0;
  h.txCalls = 0;
});

describe('reconcileEntities', () => {
  it('returns a name→id map, lowercased and trimmed', async () => {
    h.selectQueue.push(entity('e1', 'Sarah Lister'), entity('e2', 'Lister Group'));
    const map = await reconcileEntities(NODE, 'o1', [
      { name: '  Sarah Lister ', kind: 'person' },
      { name: 'Lister Group', kind: 'org' },
    ] as never);
    // The fact + relation passes look mentions up by this key, so the
    // normalisation is part of the contract, not an implementation detail.
    expect(map.get('sarah lister')).toBe('e1');
    expect(map.get('lister group')).toBe('e2');
  });

  it('writes one mentioned_in edge per mention, under the caller', async () => {
    h.selectQueue.push(entity('e1', 'Sarah'), entity('e2', 'Lister'));
    await reconcileEntities(NODE, 'o1', [
      { name: 'Sarah', kind: 'person' },
      { name: 'Lister', kind: 'org' },
    ] as never);
    expect(insertedEdges()).toHaveLength(2);
    for (const e of insertedEdges()) {
      expect(e).toMatchObject({
        ownerId: 'o1',
        sourceKind: 'entity',
        targetId: 'n1',
        targetKind: 'node',
        relation: 'mentioned_in',
      });
    }
  });

  it('does ALL its lookup work BEFORE the transaction opens', async () => {
    // The ordering that matters: delete-first meant a crash mid-loop destroyed
    // the previous extraction's edges with nothing to replace them.
    h.selectQueue.push(entity('e1', 'A'), entity('e2', 'B'));
    await reconcileEntities(NODE, 'o1', [
      { name: 'A', kind: 'person' },
      { name: 'B', kind: 'person' },
    ] as never);
    // No select ran with a delete already behind it.
    expect(h.deletesDuringSelect).toEqual([0, 0]);
    expect(h.txCalls).toBe(1);
    expect(h.deletes).toHaveLength(2);
  });

  it('REPLACES both edge directions, so a re-extract does not double the graph', async () => {
    h.selectQueue.push(entity('e1', 'Sarah'));
    await reconcileEntities(NODE, 'o1', [{ name: 'Sarah', kind: 'person' }] as never);
    // Inbound mentioned_in AND outbound references — clearing only one leaves
    // the other accumulating on every pass.
    expect(h.deletes).toHaveLength(2);
    expect(h.txCalls).toBe(1);
  });

  it('survives ONE mention that blows up, keeping the rest', async () => {
    h.selectQueue.push(new Error('candidate lookup failed'), entity('e2', 'Fine'));
    const map = await reconcileEntities(NODE, 'o1', [
      { name: 'Broken', kind: 'person' },
      { name: 'Fine', kind: 'person' },
    ] as never);
    expect(map.has('broken')).toBe(false);
    expect(map.get('fine')).toBe('e2');
    expect(insertedEdges()).toHaveLength(1);
  });

  it('still clears the old edges when every mention fails', async () => {
    // A document that no longer resolves anyone must end with no edges, not
    // with last week's.
    h.selectQueue.push(new Error('down'));
    await reconcileEntities(NODE, 'o1', [{ name: 'A', kind: 'person' }] as never);
    expect(h.deletes).toHaveLength(2);
    expect(h.inserted).toEqual([]);
  });

  it('rebuilds even for a node with no mentions at all', async () => {
    await reconcileEntities(NODE, 'o1', [] as never);
    expect(h.deletes).toHaveLength(2);
    expect(h.inserted).toEqual([]);
  });
});
