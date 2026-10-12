/**
 * The `actor-misses-reap` sweep (workspaces arch A2a): actor check miss rows
 * go 14 days after they were written, in batches until a short one; a dry
 * run only counts. The database is a double that records each statement.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { sql: string; params: unknown[] }[],
  results: [] as unknown[][],
}));

vi.mock('@mantle/db', () => ({
  db: {
    execute: async (q: SQL) => {
      const { sql, params } = new PgDialect().sqlToQuery(q);
      h.statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return h.results.shift() ?? [];
    },
  },
}));

import {
  ACTOR_MISSES_RETENTION_DAYS,
  reapActorMisses,
  summariseActorMissesReap,
} from './actor-misses-reap';

const NOW = new Date('2026-10-12T00:00:00.000Z');
const CUTOFF = '2026-09-28T00:00:00.000Z';

beforeEach(() => {
  h.statements.length = 0;
  h.results.length = 0;
});

describe('actor-misses-reap', () => {
  it('keeps 14 days', () => {
    expect(ACTOR_MISSES_RETENTION_DAYS).toBe(14);
  });

  it('deletes in batches past the cutoff until a short batch', async () => {
    h.results.push(new Array(10_000).fill({ id: 1 }), [{ id: 2 }, { id: 3 }]);
    expect(await reapActorMisses({ now: NOW })).toEqual({ deleted: 10_002 });
    expect(h.statements).toHaveLength(2);
    for (const s of h.statements) {
      expect(s.sql).toMatch(/^delete from actor_check_misses where id in \(/);
      expect(s.sql).toContain('where at < $1::timestamptz limit $2');
      expect(s.params).toEqual([CUTOFF, 10_000]);
    }
  });

  it('a dry run counts and deletes nothing', async () => {
    h.results.push([{ n: 5 }]);
    expect(await reapActorMisses({ now: NOW, dryRun: true })).toEqual({ deleted: 5 });
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0]!.sql).toMatch(/^select count\(\*\)::int as n from actor_check_misses/);
    expect(h.statements[0]!.params).toEqual([CUTOFF]);
  });

  it('summarises for the run row', () => {
    expect(summariseActorMissesReap({ deleted: 0 })).toBe('nothing to reap');
    expect(summariseActorMissesReap({ deleted: 3 })).toBe('deleted 3 actor miss row(s)');
  });
});
