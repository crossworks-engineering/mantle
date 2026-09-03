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
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  siblings: [] as unknown[],
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
      then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
        Promise.resolve(h.siblings).then(res, rej),
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
      fn({ setOutput: vi.fn(), setMeta: vi.fn() }),
  };
});

import { supersedeFileVersions } from './supersede';
import { sqlValues } from './test-support';

/** A sibling row as the query returns it. Newest first is NOT assumed — the
 *  helper sorts by createdAt itself. */
const sibling = (id: string, title: string, daysAgo: number) => ({
  id,
  title,
  createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  salience: 1,
  supersededBy: null,
  supersededReason: null,
});

const NODE = (title: string) =>
  ({ id: 'n1', ownerId: 'o1', type: 'file', title, parentId: 'f1' }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.siblings.length = 0;
  h.selectWheres.length = 0;
  h.updates.length = 0;
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

  it('writes nothing when the file is the only version of itself', async () => {
    h.siblings.push(sibling('n1', 'report-2026-03.xlsx', 0));
    await supersedeFileVersions(NODE('report-2026-03.xlsx'), 'o1');
    expect(h.updates).toEqual([]);
  });
});
