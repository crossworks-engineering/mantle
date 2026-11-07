/**
 * The fact classifier and per-login rows (screenshots final audit, M2). A
 * node's extraction compares a candidate fact only with the facts its login
 * reads: a per-login node (an area screenshot, a chat) with shared facts and
 * its own login's, a shared node with shared facts only, so another login's
 * fact text never reaches this extraction's model. And it changes (retires,
 * replaces, re-confirms) only a fact of its own login: a per-login node's
 * DELETE or UPDATE of a shared fact adds its own instead, and its NOOP
 * writes nothing. Two logins, X and Y; the database is stood in, and its
 * neighbour select answers by the login term it is given, as Postgres would.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fact = { id: string; content: string; loginId: string | null; dist: number };

const h = vi.hoisted(() => ({
  facts: [] as Array<{ id: string; content: string; loginId: string | null; dist: number }>,
  selectWheres: [] as unknown[],
  inserts: [] as unknown[],
  updates: [] as Array<{ patch: Record<string, unknown>; where: unknown }>,
  chatComplete: vi.fn(),
  prompts: [] as string[],
}));

const rendered = (clause: unknown) => new PgDialect().sqlToQuery(clause as SQL);

/** The stand-in facts the neighbour select's login term matches. */
function readable(clause: unknown): Fact[] {
  const { sql, params } = rendered(clause);
  const own = /"login_id" = \$(\d+)/.exec(sql);
  const login = own ? params[Number(own[1]) - 1] : null;
  if (!/"login_id" is null/.test(sql)) return h.facts;
  return h.facts.filter((f) => f.loginId === null || (login !== null && f.loginId === login));
}

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
    select: vi.fn(() => {
      let clause: unknown;
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn((c: unknown) => {
          clause = c;
          h.selectWheres.push(c);
          return chain;
        }),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(async () => readable(clause)),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        h.inserts.push(row);
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [{ id: 'new-fact' }],
        });
      }),
    })),
    execute: vi.fn(async () => []),
  };
  return {
    ...actual,
    db,
    withHeads: async (_ids: unknown, _mode: unknown, fn: (tx: unknown) => unknown) => fn(db),
    withDeadlockRetry: async (fn: () => unknown) => fn(),
  };
});
vi.mock('@mantle/embeddings', () => ({
  embedBatch: vi.fn(async (_o: string, texts: string[]) => texts.map(() => [0.1])),
  embed: vi.fn(),
}));
vi.mock('@mantle/decisions', () => ({ prefilterFactAdd: async () => null }));
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    currentTrace: () => ({ costMicroUsd: 0 }),
    step: async (_spec: unknown, fn: (handle: unknown) => Promise<unknown>) =>
      fn({ setSkipped: vi.fn(), setMeta: vi.fn(), setOutput: vi.fn() }),
  };
});
vi.mock('./model', () => ({
  chatComplete: async (...args: unknown[]) => {
    h.prompts.push(String(args[3]));
    return h.chatComplete();
  },
  resolveExtractor: vi.fn(),
}));

import { processFacts } from './facts';
import { sqlValues } from './test-support';

const X = '00000000-0000-4000-8000-0000000000a1';
const Y = '00000000-0000-4000-8000-0000000000b2';
const WORKER = { id: 'w1', slug: 'extractor', provider: 'local', model: 'm' } as never;
const nodeOf = (loginId: string | null) =>
  ({ id: 'n1', ownerId: 'o1', type: 'file', title: 'T', data: {}, loginId }) as never;
const one = { summary: 's', entities: [], facts: [{ content: 'Acme ships pumps', entities: [] }] };
const decide = (decision: string) =>
  h.chatComplete.mockResolvedValue({
    text: JSON.stringify({ decision, target_index: 1 }),
    model: 'm',
  });

/** The writes that name fact `id` (a retire, a replacement, a re-confirm). */
const writesTo = (id: string) => h.updates.filter((u) => sqlValues(u.where).includes(id));

beforeEach(() => {
  vi.clearAllMocks();
  h.facts.length = 0;
  h.selectWheres.length = 0;
  h.inserts.length = 0;
  h.updates.length = 0;
  h.prompts.length = 0;
});

describe('the fact classifier and per-login rows', () => {
  it("X's node compares with shared facts and X's own, never Y's", async () => {
    h.facts.push(
      { id: 'f-shared', content: 'shared: Acme ships pumps', loginId: null, dist: 0.1 },
      { id: 'f-x', content: 'x: Acme ships pumps', loginId: X, dist: 0.1 },
      { id: 'f-y', content: "y's private: Acme ships pumps", loginId: Y, dist: 0.05 },
    );
    decide('ADD');
    await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
    const q = rendered(h.selectWheres[0]);
    expect(q.sql).toMatch(/"login_id" is null or "facts"\."login_id" = \$\d+/);
    expect(q.params).toContain(X);
    expect(h.prompts.join('\n')).toContain('shared: Acme ships pumps');
    expect(h.prompts.join('\n')).not.toContain("y's private");
  });

  it('a shared node compares with shared facts only', async () => {
    h.facts.push(
      { id: 'f-shared', content: 'shared: Acme ships pumps', loginId: null, dist: 0.1 },
      { id: 'f-x', content: "x's private: Acme ships pumps", loginId: X, dist: 0.05 },
    );
    decide('ADD');
    await processFacts(nodeOf(null), 'o1', WORKER, {}, one as never, new Map());
    const q = rendered(h.selectWheres[0]);
    expect(q.sql).toMatch(/"login_id" is null/);
    expect(q.sql).not.toMatch(/"login_id" = \$/);
    expect(h.prompts.join('\n')).not.toContain("x's private");
  });

  for (const decision of ['DELETE', 'UPDATE'] as const) {
    it(`X's node never ${decision === 'DELETE' ? 'retires' : 'replaces'} a shared fact: it adds its own`, async () => {
      h.facts.push({ id: 'f-shared', content: 'Acme ships pumps', loginId: null, dist: 0.1 });
      decide(decision);
      const tally = await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
      expect(writesTo('f-shared')).toEqual([]);
      expect(tally.ADD).toBe(1);
      expect(h.inserts).toHaveLength(1);
    });
  }

  it("X's NOOP on a shared fact writes nothing to it", async () => {
    h.facts.push({ id: 'f-shared', content: 'Acme ships pumps', loginId: null, dist: 0.1 });
    decide('NOOP');
    const tally = await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
    expect(tally.NOOP).toBe(1);
    expect(writesTo('f-shared')).toEqual([]);
  });

  it("a shared node never retires X's fact, even were it handed one", async () => {
    // A stand-in that ignores the login term, as a defence: the write check
    // still holds.
    h.facts.push({ id: 'f-x', content: 'Acme ships pumps', loginId: X, dist: 0.1 });
    const { db } = await import('@mantle/db');
    vi.mocked(db.select).mockImplementationOnce((() => {
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () => h.facts,
      };
      return chain;
    }) as never);
    decide('DELETE');
    await processFacts(nodeOf(null), 'o1', WORKER, {}, one as never, new Map());
    expect(writesTo('f-x')).toEqual([]);
  });

  it("the control: X's node retires and replaces X's own fact", async () => {
    h.facts.push({ id: 'f-x', content: 'Acme ships pumps', loginId: X, dist: 0.1 });
    decide('DELETE');
    const del = await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
    expect(del.DELETE).toBe(1);
    expect(writesTo('f-x').some((u) => 'validTo' in u.patch)).toBe(true);
    h.updates.length = 0;
    decide('UPDATE');
    const upd = await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
    expect(upd.UPDATE).toBe(1);
    expect(writesTo('f-x').some((u) => 'validTo' in u.patch)).toBe(true);
  });
});
