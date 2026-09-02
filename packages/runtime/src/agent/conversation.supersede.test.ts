/**
 * The supersede convention (premature-Enter correction flow): both rows of a
 * cancelled turn pair get `data.superseded_by = <newTurnId>`, and every prompt
 * source (history, digests) must exclude flagged rows.
 *
 * These are SQL-shape tests: `@mantle/db` is mocked with a chain-capturing
 * `db` (the real module's schema + `notSuperseded` are kept via importOriginal
 * — its `db` export is a lazy proxy, so importing opens no connection), and
 * the captured WHERE / SET fragments are compiled with PgDialect to pin the
 * owner scoping and the merge semantics. Foreign ids are no-ops BY
 * CONSTRUCTION: the UPDATE's WHERE carries `owner_id = $owner`, so a row id
 * guessed from another owner matches nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  updates: [] as Array<{ payload: Record<string, unknown>; where: unknown }>,
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: (where: unknown) => {
          h.updates.push({ payload, where });
          return {
            returning: () => Promise.resolve([{ id: 'in-1' }, { id: 'out-1' }]),
          };
        },
      }),
    }),
  },
}));

import { notSuperseded } from '@mantle/db';
import { markTurnSuperseded } from './conversation';

const dialect = new PgDialect();
const compile = (fragment: SQL) => dialect.sqlToQuery(fragment);

describe('notSuperseded()', () => {
  it('compiles to a jsonb key-absence test on assistant_messages.data', () => {
    const q = compile(notSuperseded());
    expect(q.sql).toBe(`not ("assistant_messages"."data" ? 'superseded_by')`);
    expect(q.params).toEqual([]);
  });
});

describe('markTurnSuperseded', () => {
  it('stamps BOTH pair rows, owner-scoped, via a data-merge (not a replace)', async () => {
    h.updates.length = 0;
    const n = await markTurnSuperseded({
      ownerId: 'owner-1',
      inboundId: 'in-1',
      outboundId: 'out-1',
      newTurnId: 'turn-2',
    });
    expect(n).toBe(2);
    expect(h.updates).toHaveLength(1);

    const { payload, where } = h.updates[0]!;
    // The stamp merges onto the existing jsonb (`data || patch`) so it can't
    // clobber thoughts/toolStats — and survives the finalize merge in turn.
    const set = compile(payload.data as SQL);
    expect(set.sql).toContain(`"assistant_messages"."data" || `);
    expect(set.params).toEqual([JSON.stringify({ superseded_by: 'turn-2' })]);

    // Owner scoping: id ∈ (inbound, outbound) AND owner_id = $owner — ids
    // guessed from another owner match nothing.
    const cond = compile(where as SQL);
    expect(cond.sql).toContain(`"assistant_messages"."id" in (`);
    expect(cond.sql).toContain(`"assistant_messages"."owner_id" = `);
    expect(cond.params).toEqual(['in-1', 'out-1', 'owner-1']);
  });
});
