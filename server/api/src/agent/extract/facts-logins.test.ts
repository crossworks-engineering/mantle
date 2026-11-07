/**
 * The fact classifier and per-login rows (screenshots final audit, M2, and
 * its follow-up). A node's extraction compares a candidate fact only with
 * the facts readable in its own scope: a per-login node (an area
 * screenshot, a chat) with its own login's facts and the shared facts a
 * workspace of that login reads, a shared node with the shared facts a
 * workspace reading it reads. So another login's fact text, or a shared
 * fact only Admin reads, never reaches a member's extraction, and a NOOP
 * against one cannot drop the member's own fact. And it changes (retires,
 * replaces, re-confirms) only a fact of its own login that no workspace
 * outside its own reads: a per-login node's DELETE or UPDATE of a shared
 * fact adds its own instead, its NOOP writes nothing, and a shared node in
 * W never retires a fact Admin reads too. Two logins, X and Y; the database
 * is stood in, and its neighbour select answers by the login and workspace
 * terms it is given, as Postgres would.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fact = {
  id: string;
  content: string;
  loginId: string | null;
  readWs: string[];
  dist: number;
};

const h = vi.hoisted(() => ({
  facts: [] as Array<{
    id: string;
    content: string;
    loginId: string | null;
    readWs: string[];
    dist: number;
  }>,
  /** The workspaces each login reads (loginScopeFor). */
  loginWs: {} as Record<string, string[]>,
  /** The workspaces holding the node extracted (nodes.read_ws). */
  nodeWs: [] as string[],
  selectWheres: [] as unknown[],
  inserts: [] as unknown[],
  updates: [] as Array<{ patch: Record<string, unknown>; where: unknown }>,
  chatComplete: vi.fn(),
  prompts: [] as string[],
}));

const rendered = (clause: unknown) => new PgDialect().sqlToQuery(clause as SQL);

/** The stand-in facts the neighbour select's login and workspace terms
 *  match, as Postgres would: its own login's, or shared ones whose
 *  workspaces meet the ones it names (a login's, as a parameter; the
 *  node's, read from the node; none: every shared one). Each row also
 *  says, as the select does, whether the node's workspaces hold all of
 *  the fact's (none: true). */
function readable(clause: unknown): Array<Fact & { withinNode: boolean }> {
  const within = (f: Fact) => h.nodeWs.length === 0 || f.readWs.every((w) => h.nodeWs.includes(w));
  const withFlag = (fs: Fact[]) => fs.map((f) => ({ ...f, withinNode: within(f) }));
  const { sql, params } = rendered(clause);
  if (!/"login_id" is null/.test(sql)) return withFlag(h.facts);
  const own = /"login_id" = \$(\d+)/.exec(sql);
  const login = own ? params[Number(own[1]) - 1] : null;
  const wsTerm = /read_ws && \$(\d+)::uuid\[\]/.exec(sql);
  const ws = wsTerm
    ? String(params[Number(wsTerm[1]) - 1])
        .replace(/[{}]/g, '')
        .split(',')
        .filter(Boolean)
    : /read_ws && \(select n\.read_ws from/.test(sql) && h.nodeWs.length > 0
      ? h.nodeWs
      : null;
  return withFlag(
    h.facts.filter(
      (f) =>
        (login !== null && f.loginId === login) ||
        (f.loginId === null && (ws === null || f.readWs.some((w) => ws.includes(w)))),
    ),
  );
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
    loginScopeFor: async (loginId: string) => ({
      kind: 'login',
      loginId,
      ws: h.loginWs[loginId] ?? [],
      modWs: [],
    }),
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
/** Workspaces: Admin, a shared one W, and X's private one P. */
const ADMIN = '00000000-0000-4000-8000-00000000ad00';
const W = '00000000-0000-4000-8000-00000000aa00';
const P = '00000000-0000-4000-8000-00000000bb00';
const WORKER = { id: 'w1', slug: 'extractor', provider: 'local', model: 'm' } as never;
/** The node extracted; `holders` the workspaces holding it (read in the
 *  query from nodes, here the stand-in's). */
const nodeOf = (loginId: string | null, holders: string[] = []) => {
  h.nodeWs = holders;
  return { id: 'n1', ownerId: 'o1', type: 'file', title: 'T', data: {}, loginId } as never;
};
const fact = (id: string, content: string, loginId: string | null, readWs: string[] = []) => ({
  id,
  content,
  loginId,
  readWs,
  dist: 0.1,
});
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
  h.loginWs = {};
  h.nodeWs = [];
});

describe('the fact classifier and per-login rows', () => {
  it("X's node compares with shared facts and X's own, never Y's", async () => {
    h.facts.push(
      fact('f-shared', 'shared: Acme ships pumps', null),
      fact('f-x', 'x: Acme ships pumps', X),
      { ...fact('f-y', "y's private: Acme ships pumps", Y), dist: 0.05 },
    );
    decide('ADD');
    await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
    const q = rendered(h.selectWheres[0]);
    expect(q.sql).toMatch(/"login_id" = \$\d+::uuid or "facts"\."login_id" is null/);
    expect(q.params).toContain(X);
    expect(h.prompts.join('\n')).toContain('shared: Acme ships pumps');
    expect(h.prompts.join('\n')).not.toContain("y's private");
  });

  it('a shared node compares with shared facts only', async () => {
    h.facts.push(fact('f-shared', 'shared: Acme ships pumps', null), {
      ...fact('f-x', "x's private: Acme ships pumps", X),
      dist: 0.05,
    });
    decide('ADD');
    await processFacts(nodeOf(null), 'o1', WORKER, {}, one as never, new Map());
    const q = rendered(h.selectWheres[0]);
    expect(q.sql).toMatch(/"login_id" is null/);
    expect(q.sql).not.toMatch(/"login_id" = \$/);
    expect(h.prompts.join('\n')).not.toContain("x's private");
  });

  for (const decision of ['DELETE', 'UPDATE'] as const) {
    it(`X's node never ${decision === 'DELETE' ? 'retires' : 'replaces'} a shared fact: it adds its own`, async () => {
      h.facts.push(fact('f-shared', 'Acme ships pumps', null));
      decide(decision);
      const tally = await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
      expect(writesTo('f-shared')).toEqual([]);
      expect(tally.ADD).toBe(1);
      expect(h.inserts).toHaveLength(1);
    });
  }

  it("X's NOOP on a shared fact writes nothing to it", async () => {
    h.facts.push(fact('f-shared', 'Acme ships pumps', null));
    decide('NOOP');
    const tally = await processFacts(nodeOf(X), 'o1', WORKER, {}, one as never, new Map());
    expect(tally.NOOP).toBe(1);
    expect(writesTo('f-shared')).toEqual([]);
  });

  it("a shared node never retires X's fact, even were it handed one", async () => {
    // A stand-in that ignores the login term, as a defence: the write check
    // still holds.
    h.facts.push(fact('f-x', 'Acme ships pumps', X));
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

  it("a member's screenshot never compares with a shared fact only Admin reads; its fact is added", async () => {
    // X is a member: it reads its private workspace P and the shared W.
    h.loginWs[X] = [P, W];
    h.facts.push(
      { ...fact('f-admin', 'admin only: Acme ships pumps', null, [ADMIN]), dist: 0.01 },
      fact('f-w', 'in W: Acme ships pumps', null, [W]),
    );
    decide('NOOP');
    await processFacts(nodeOf(X, [P]), 'o1', WORKER, {}, one as never, new Map());
    const q = rendered(h.selectWheres[0]);
    expect(q.sql).toMatch(/read_ws && \$\d+::uuid\[\]/);
    expect(q.params).toContain(`{${P},${W}}`);
    expect(h.prompts.join('\n')).not.toContain('admin only');
    expect(h.prompts.join('\n')).toContain('in W: Acme ships pumps');
    // With only the Admin fact near it, nothing is near: the member's own
    // fact is added, never dropped by a NOOP against a fact it cannot read.
    h.facts.splice(1, 1);
    h.inserts.length = 0;
    h.prompts.length = 0;
    const tally = await processFacts(nodeOf(X, [P]), 'o1', WORKER, {}, one as never, new Map());
    expect(tally.ADD).toBe(1);
    expect(h.inserts).toHaveLength(1);
    expect(h.prompts).toEqual([]);
    expect(writesTo('f-admin')).toEqual([]);
  });

  it('a shared node compares only with shared facts a workspace reading it reads', async () => {
    h.facts.push(
      { ...fact('f-admin', 'admin only: Acme ships pumps', null, [ADMIN]), dist: 0.01 },
      fact('f-w', 'in W: Acme ships pumps', null, [W]),
    );
    decide('ADD');
    await processFacts(nodeOf(null, [W]), 'o1', WORKER, {}, one as never, new Map());
    expect(rendered(h.selectWheres[0]).sql).toMatch(/read_ws && \(select n\.read_ws from/);
    expect(h.prompts.join('\n')).not.toContain('admin only');
    expect(h.prompts.join('\n')).toContain('in W');
  });

  for (const decision of ['DELETE', 'UPDATE'] as const) {
    it(`a shared node in W never ${decision === 'DELETE' ? 'retires' : 'replaces'} a shared fact Admin reads too`, async () => {
      // Readable in W (a neighbour), but Admin reads it as well.
      h.facts.push(fact('f-wa', 'Acme ships pumps', null, [W, ADMIN]));
      decide(decision);
      const tally = await processFacts(
        nodeOf(null, [W]),
        'o1',
        WORKER,
        {},
        one as never,
        new Map(),
      );
      expect(writesTo('f-wa')).toEqual([]);
      expect(tally.ADD).toBe(1);
    });
  }

  it("a shared node in W retires and replaces a shared fact of W's own (the control)", async () => {
    h.facts.push(fact('f-w', 'Acme ships pumps', null, [W]));
    decide('DELETE');
    const del = await processFacts(nodeOf(null, [W]), 'o1', WORKER, {}, one as never, new Map());
    expect(del.DELETE).toBe(1);
    expect(writesTo('f-w').some((u) => 'validTo' in u.patch)).toBe(true);
    h.updates.length = 0;
    decide('UPDATE');
    const upd = await processFacts(nodeOf(null, [W]), 'o1', WORKER, {}, one as never, new Map());
    expect(upd.UPDATE).toBe(1);
    expect(writesTo('f-w').some((u) => 'validTo' in u.patch)).toBe(true);
  });

  it('a brain not on workspaces (no read_ws): every shared fact counts, as before', async () => {
    h.facts.push(fact('f-shared', 'shared: Acme ships pumps', null));
    decide('DELETE');
    const tally = await processFacts(nodeOf(null), 'o1', WORKER, {}, one as never, new Map());
    expect(tally.DELETE).toBe(1);
  });

  it("the control: X's node retires and replaces X's own fact", async () => {
    h.facts.push(fact('f-x', 'Acme ships pumps', X));
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
