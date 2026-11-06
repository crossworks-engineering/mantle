/**
 * `supersedeFileVersions` — applying the version plan.
 *
 * The plan itself (which sibling is the head, which are demoted, when the head
 * is restored, manual marks outranking the heuristic) is `planFileVersionSupersede`
 * and is unit-tested in rules.test.ts. This file covers the half that talks to
 * the database, which those pure tests cannot see:
 *
 *  - The sibling query is scoped to the caller, to `file`, and to the same
 *    parent folder. Drop the owner term and one brain's re-upload demotes
 *    another brain's documents; drop the parent term and two unrelated
 *    "report-2026-01.xlsx" files in different folders become one family.
 *  - Only same-family siblings are considered — the query cannot express
 *    `fileFamilyKey`, so the filter happens in memory and must actually happen.
 *  - A title with no family key writes nothing at all.
 *  - The sibling query matches the node's login: a per-login row (an area
 *    screenshot; every screenshot of a folder is one family) groups only
 *    with its own login's, a shared row only with shared rows. The stand-in
 *    database answers by that term, as Postgres would, so two logins'
 *    screenshots in one family never demote or name each other.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  siblings: [] as Array<Record<string, unknown>>,
  outputs: [] as unknown[],
  selectWheres: [] as unknown[],
  /** Each update: the patch and the ids it targeted. */
  updates: [] as Array<{ patch: Record<string, unknown>; where: unknown }>,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const db = {
    ...actual.db,
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn(function (this: unknown, clause: unknown) {
        h.selectWheres.push(clause);
        return this;
      }),
      // As Postgres would: rows of the login the query names, or the
      // shared ones when it asks for login_id is null.
      then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
        Promise.resolve(byLogin(h.selectWheres.at(-1))).then(res, rej),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        const rec = { patch, where: undefined as unknown };
        h.updates.push(rec);
        return {
          where: vi.fn(async (clause: unknown) => {
            rec.where = clause;
          }),
        };
      }),
    })),
  };
  return { ...actual, db };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    step: async (_spec: unknown, fn: (handle: unknown) => Promise<unknown>) =>
      fn({ setOutput: (o: unknown) => h.outputs.push(o), setMeta: vi.fn() }),
  };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { supersedeFileVersions } from './supersede';
import { sqlValues } from './test-support';

/** The sibling query's WHERE as Postgres gets it. */
const rendered = (clause: unknown) => new PgDialect().sqlToQuery(clause as SQL);

/** The stand-in rows the query's login term matches (no term: all). */
function byLogin(clause: unknown): Array<Record<string, unknown>> {
  if (!clause) return h.siblings;
  const { sql, params } = rendered(clause);
  if (/"login_id" is null/.test(sql)) return h.siblings.filter((s) => s.loginId == null);
  const m = /"login_id" = \$(\d+)/.exec(sql);
  if (!m) return h.siblings;
  const login = params[Number(m[1]) - 1];
  return h.siblings.filter((s) => s.loginId === login);
}

/** A sibling row as the query returns it. Newest first is NOT assumed — the
 *  helper sorts by createdAt itself. */
const sibling = (id: string, title: string, daysAgo: number, loginId: string | null = null) => ({
  id,
  title,
  createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  salience: 1,
  supersededBy: null,
  supersededReason: null,
  loginId,
});

const NODE = (title: string, loginId: string | null = null) =>
  ({ id: 'n1', ownerId: 'o1', type: 'file', title, parentId: 'f1', loginId }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.siblings.length = 0;
  h.selectWheres.length = 0;
  h.updates.length = 0;
  h.outputs.length = 0;
});

describe('supersedeFileVersions', () => {
  it('scopes the sibling query to the caller, to files, and to the same folder', async () => {
    h.siblings.push(sibling('n1', 'report-2026-02.xlsx', 0));
    await supersedeFileVersions(NODE('report-2026-02.xlsx'), 'o1');
    const params = sqlValues(h.selectWheres[0]);
    expect(params).toEqual(expect.arrayContaining(['o1', 'file', 'f1']));
  });

  it('demotes every older version and points it at the newest', async () => {
    h.siblings.push(
      sibling('n1', 'report-2026-03.xlsx', 0),
      sibling('n2', 'report-2026-02.xlsx', 30),
      sibling('n3', 'report-2026-01.xlsx', 60),
    );
    await supersedeFileVersions(NODE('report-2026-03.xlsx'), 'o1');
    const demote = h.updates.find((u) => u.patch.supersededReason === 'version');
    expect(demote?.patch).toMatchObject({ supersededBy: 'n1', supersededReason: 'version' });
    expect(demote?.patch.salience).toBeLessThan(1);
    // Only the older two — demoting the head is the bug this heuristic keeps
    // re-introducing, and it makes the current document the least retrievable.
    expect(sqlValues(demote?.where)).toEqual(expect.arrayContaining(['n2', 'n3']));
    expect(sqlValues(demote?.where)).not.toContain('n1');
  });

  it('ignores siblings from a DIFFERENT family in the same folder', async () => {
    // The query cannot express fileFamilyKey, so the filter is in memory. Lose
    // it and every file in a folder becomes one version chain.
    h.siblings.push(
      sibling('n1', 'report-2026-03.xlsx', 0),
      sibling('n2', 'report-2026-02.xlsx', 30),
      sibling('n9', 'unrelated-notes.md', 45),
    );
    await supersedeFileVersions(NODE('report-2026-03.xlsx'), 'o1');
    const demote = h.updates.find((u) => u.patch.supersededReason === 'version');
    expect(sqlValues(demote?.where)).toContain('n2');
    expect(sqlValues(demote?.where)).not.toContain('n9');
  });

  it('restores a head a previous pass demoted, self-healing', async () => {
    h.siblings.push(
      {
        ...sibling('n1', 'report-2026-03.xlsx', 0),
        salience: 0.5,
        supersededBy: 'n2',
        supersededReason: 'version',
      },
      sibling('n2', 'report-2026-02.xlsx', 30),
    );
    await supersedeFileVersions(NODE('report-2026-03.xlsx'), 'o1');
    const restore = h.updates.find((u) => u.patch.salience === 1);
    expect(restore?.patch).toMatchObject({ supersededBy: null, supersededReason: null });
    expect(sqlValues(restore?.where)).toContain('n1');
  });

  it('writes nothing for a title with no family key', async () => {
    await supersedeFileVersions(NODE('notes.md'), 'o1');
    expect(h.updates).toEqual([]);
    expect(h.selectWheres).toEqual([]);
  });

  it("a per-login screenshot is a version only of its own login's: two logins in one family", async () => {
    // Every screenshot of a month folder is one family (the date is the
    // version token). X's newest is extracted; Y's sit in the same folder.
    const X = 'login-x';
    const Y = 'login-y';
    h.siblings.push(
      sibling('n1', 'screenshot-2026-11-06-120000.png', 0, X),
      sibling('x2', 'screenshot-2026-11-05-120000.png', 1, X),
      sibling('y1', 'screenshot-2026-11-06-130000.png', 0.01, Y),
      sibling('y2', 'screenshot-2026-11-04-120000.png', 2, Y),
      sibling('s1', 'screenshot-2026-11-03-120000.png', 3, null),
    );
    await supersedeFileVersions(NODE('screenshot-2026-11-06-120000.png', X), 'o1');
    const q = rendered(h.selectWheres[0]);
    expect(q.sql).toMatch(/"login_id" = \$\d+/);
    expect(q.params).toContain(X);
    const demote = h.updates.find((u) => u.patch.supersededReason === 'version');
    expect(demote?.patch).toMatchObject({ supersededBy: 'n1' });
    expect(sqlValues(demote?.where)).toContain('x2');
    for (const u of h.updates) {
      for (const id of ['y1', 'y2', 's1']) expect(sqlValues(u.where)).not.toContain(id);
    }
    // The trace names X's versions only.
    expect(h.outputs).toEqual([
      expect.objectContaining({
        versions: 2,
        demoted: 1,
        newest: 'screenshot-2026-11-06-120000.png',
      }),
    ]);
  });

  it("Y's newer screenshot never becomes X's head, nor X's Y's", async () => {
    const X = 'login-x';
    const Y = 'login-y';
    h.siblings.push(
      sibling('y1', 'screenshot-2026-11-06-130000.png', 0, Y),
      sibling('n1', 'screenshot-2026-11-06-120000.png', 0.01, X),
    );
    await supersedeFileVersions(NODE('screenshot-2026-11-06-120000.png', X), 'o1');
    // X's is the only version of itself: nothing written.
    expect(h.updates).toEqual([]);
    expect(h.outputs).toEqual([expect.objectContaining({ versions: 1, demoted: 0 })]);
  });

  it('a shared file groups only with shared files (login_id is null)', async () => {
    h.siblings.push(
      sibling('n1', 'report-2026-03.xlsx', 0),
      sibling('n2', 'report-2026-02.xlsx', 30),
      sibling('p1', 'report-2026-01.xlsx', 60, 'login-x'),
    );
    await supersedeFileVersions(NODE('report-2026-03.xlsx'), 'o1');
    expect(rendered(h.selectWheres[0]).sql).toMatch(/"login_id" is null/);
    const demote = h.updates.find((u) => u.patch.supersededReason === 'version');
    expect(sqlValues(demote?.where)).toContain('n2');
    expect(sqlValues(demote?.where)).not.toContain('p1');
  });

  it('writes nothing when the file is the only version of itself', async () => {
    h.siblings.push(sibling('n1', 'report-2026-03.xlsx', 0));
    await supersedeFileVersions(NODE('report-2026-03.xlsx'), 'o1');
    expect(h.updates).toEqual([]);
  });
});
