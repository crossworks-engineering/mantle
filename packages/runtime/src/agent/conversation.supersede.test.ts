/**
 * The supersede convention (premature-Enter correction flow): both rows of a
 * cancelled turn pair get `data.superseded_by = <newTurnId>`, and every prompt
 * source (history, digests) must exclude flagged rows.
 *
 * The stamp itself is @mantle/db supersedeConversationTurn (its SQL shape:
 * the owner and login scoping and the merge, conversation-writes.test.ts);
 * here `notSuperseded` compiles as the history reads it, and
 * markTurnSuperseded hands the pair on unchanged.
 */

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  calls: [] as unknown[],
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supersedeConversationTurn: async (args: unknown) => {
    h.calls.push(args);
    return 2;
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
  it('hands the pair, its owner and its login to the system-pool stamp', async () => {
    const args = {
      ownerId: 'owner-1',
      inboundId: 'in-1',
      outboundId: 'out-1',
      newTurnId: 'turn-2',
      loginId: 'login-1',
    };
    expect(await markTurnSuperseded(args)).toBe(2);
    expect(h.calls).toEqual([args]);
  });
});
