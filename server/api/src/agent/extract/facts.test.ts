/**
 * `processFacts` — the H4 dirty-flag protocol and the cost cap.
 *
 * The per-fact classifier is stubbed here; what these tests pin is the
 * bookkeeping AROUND it, because that is where a mistake destroys data rather
 * than merely producing a worse answer:
 *
 *  - Every live fact this node produced is marked suspect before the loop and
 *    the survivors are retired after it. That is what stops a fact deleted from
 *    an edited document living on with `valid_to = NULL` forever. Lose the
 *    owner or node scoping on either statement and one node's re-extract
 *    retires the whole brain's facts.
 *  - A cost-cap break must NOT retire. The later candidates were never looked
 *    at, so "not re-asserted" says nothing about them; the run instead clears
 *    the suspect flag and leaves a durable `data.extract_incomplete` marker, so
 *    a paid-for fact that was dropped is recoverable rather than invisible.
 *  - A cap of 0 means UNLIMITED, not "zero budget". `?? null` alone let a
 *    configured 0 through, and since the llm_extract step has already spent
 *    money by this point, `spent >= 0` is always true — every fact would be
 *    dropped at #0.
 *  - An embed-batch failure THROWS, so the queue retries. Returning quietly
 *    meant this node's facts were never written and never would be.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  embedBatch: vi.fn(),
  chatComplete: vi.fn(),
  /** Fact rows inserted — one per candidate that reached the apply step. */
  inserts: [] as unknown[],
  cost: 0,
  /** How many of the next inserts should throw. */
  insertFails: 0,
  /** Each db.update(table) call: the patch, and the where clause. */
  updates: [] as Array<{ patch: Record<string, unknown>; where: unknown }>,
  setSkipped: vi.fn(),
  setMeta: vi.fn(),
  setOutput: vi.fn(),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const db = {
    ...actual.db,
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        const rec = { patch, where: undefined as unknown };
        h.updates.push(rec);
        const where = (clause: unknown) => {
          rec.where = clause;
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => [] as unknown[],
          });
        };
        return { where };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => []),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: unknown) => {
        h.inserts.push(row);
        if (h.insertFails-- > 0) throw new Error('insert blew up');
        return undefined;
      }),
    })),
    execute: vi.fn(async () => []),
  };
  return { ...actual, db };
});
vi.mock('@mantle/embeddings', () => ({ embedBatch: h.embedBatch, embed: vi.fn() }));
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    currentTrace: () => ({ costMicroUsd: h.cost }),
    step: async (_spec: unknown, fn: (handle: unknown) => Promise<unknown>) =>
      fn({ setSkipped: h.setSkipped, setMeta: h.setMeta, setOutput: h.setOutput }),
  };
});
vi.mock('./model', () => ({ chatComplete: h.chatComplete, resolveExtractor: vi.fn() }));

import { processFacts } from './facts';
import { sqlValues } from './test-support';

const NODE = { id: 'n1', ownerId: 'o1', type: 'note', title: 'T', data: {} } as never;
const WORKER = { id: 'w1', slug: 'extractor', provider: 'local', model: 'm' } as never;

const factsOf = (...contents: string[]) => ({
  summary: 's',
  entities: [],
  facts: contents.map((content) => ({ content, entities: [] })),
});

/** The patch objects written, in call order. */
const patches = () => h.updates.map((u) => u.patch);

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.inserts.length = 0;
  h.cost = 0;
  h.insertFails = 0;
  h.embedBatch.mockResolvedValue([[0.1], [0.2], [0.3]]);
  // The near-neighbour select returns nothing, so every candidate takes the
  // ADD fast path and the classifier is never consulted. That is deliberate:
  // the classifier's own behaviour is not what these tests are about, and one
  // insert per candidate is the cleanest "this candidate was processed" signal.
  h.chatComplete.mockResolvedValue({ text: 'NOOP', model: 'm' });
});

describe('processFacts — the dirty-flag protocol', () => {
  it('marks this node’s live facts suspect, then retires the survivors', async () => {
    const tally = await processFacts(NODE, 'o1', WORKER, {}, factsOf('a', 'b') as never, new Map());
    expect(tally.ADD).toBe(2);
    // Suspect first, retire last: reverse the order and a fact re-asserted by
    // this very pass would be retired anyway.
    expect(patches()[0]).toMatchObject({ dirty: true });
    const retire = patches().find((p) => 'validTo' in p);
    expect(retire).toMatchObject({ dirty: false });
    expect(retire?.validTo).toBeInstanceOf(Date);
    expect(tally.retired).toBe(0);
  });

  it('scopes BOTH statements to this owner and this node', async () => {
    // Without these terms a single re-extract retires facts belonging to other
    // nodes — or, with the owner term gone, to other brains.
    await processFacts(NODE, 'o1', WORKER, {}, factsOf('a') as never, new Map());
    const scoped = h.updates.filter((u) => 'dirty' in u.patch);
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    for (const u of scoped) {
      expect(sqlValues(u.where)).toEqual(expect.arrayContaining(['o1', 'n1']));
    }
  });

  it('clears a stale incomplete marker after a complete pass', async () => {
    await processFacts(NODE, 'o1', WORKER, {}, factsOf('a') as never, new Map());
    const cleared = h.updates.find((u) =>
      sqlValues(u.patch.data).some((v) => String(v).includes('extract_incomplete')),
    );
    expect(cleared).toBeDefined();
  });
});

describe('processFacts — the cost cap', () => {
  it('stops at the cap, retires NOTHING, and records a recoverable marker', async () => {
    h.cost = 5_000; // already over before the first candidate
    const tally = await processFacts(
      NODE,
      'o1',
      WORKER,
      { extract_cost_cap_micro_usd: 1_000 },
      factsOf('a', 'b', 'c') as never,
      new Map(),
    );
    expect(h.inserts).toEqual([]); // not one candidate was processed
    expect(tally.retired).toBe(0);
    // The suspect flag is cleared but no validTo is written: the later
    // candidates were never looked at, so "not re-asserted" proves nothing.
    expect(patches().some((p) => 'validTo' in p)).toBe(false);
    expect(patches().some((p) => p.dirty === false)).toBe(true);
    // And the loss is durable + queryable, not just a log line.
    const marker = h.updates.find((u) =>
      sqlValues(u.patch.data).some((v) => String(v).includes('fact_cost_cap')),
    );
    expect(String(sqlValues(marker!.patch.data))).toContain('"dropped":3');
    expect(h.setSkipped).toHaveBeenCalledWith('fact_cost_cap');
  });

  it('treats a cap of 0 as UNLIMITED, not as zero budget', async () => {
    // The `?? null` trap: a configured 0 survived, and since money has already
    // been spent by this point `spent >= 0` is always true, so every fact was
    // dropped at #0.
    h.cost = 5_000;
    const tally = await processFacts(
      NODE,
      'o1',
      WORKER,
      { extract_cost_cap_micro_usd: 0 },
      factsOf('a', 'b') as never,
      new Map(),
    );
    expect(h.inserts).toHaveLength(2);
    expect(tally.ADD).toBe(2);
    expect(h.setSkipped).not.toHaveBeenCalled();
  });
});

describe('processFacts — failures', () => {
  it('THROWS when the embed batch fails, so the queue retries', async () => {
    h.embedBatch.mockRejectedValue(new Error('embedder offline'));
    await expect(
      processFacts(NODE, 'o1', WORKER, {}, factsOf('a') as never, new Map()),
    ).rejects.toThrow(/fact embed batch failed/);
    // Nothing was marked suspect: a partial pass must not leave the node's
    // facts flagged with no run to clear them.
    expect(h.updates).toEqual([]);
  });

  it('keeps going when ONE candidate fails to apply', async () => {
    h.insertFails = 1;
    const tally = await processFacts(NODE, 'o1', WORKER, {}, factsOf('a', 'b') as never, new Map());
    // One bad fact must not cost the node its whole extraction — and the pass
    // still counts as COMPLETE, so the retire sweep runs.
    expect(tally.ADD).toBe(1);
    expect(h.inserts).toHaveLength(2);
    expect(patches().some((p) => 'validTo' in p)).toBe(true);
  });
});
