/**
 * The `ui-calls-reap` sweep (docs/agent-ui.md): agent UI call rows go 24
 * hours after they were written, in batches until a short one; a dry run
 * only counts. The database is a double that records each statement.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { sql: string; params: unknown[] }[],
  results: [] as unknown[][],
}));

function record(sql: string, params: unknown[]): unknown[] {
  h.statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  return h.results.shift() ?? [];
}

vi.mock('@mantle/db', async () => {
  const { uiCalls } =
    await vi.importActual<typeof import('@mantle/db/schema')>('@mantle/db/schema');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // The typed delete is built by drizzle itself and its text recorded.
  const builder = drizzle.mock();
  return {
    uiCalls,
    UI_CALLS_RETENTION_HOURS: 24,
    db: {
      execute: async (q: SQL) => {
        const { sql, params } = new PgDialect().sqlToQuery(q);
        return record(sql, params);
      },
      delete: (table: typeof uiCalls) => ({
        where: (cond: SQL) => ({
          returning: async (cols: { id: typeof uiCalls.id }) => {
            const { sql, params } = builder.delete(table).where(cond).returning(cols).toSQL();
            return record(sql, params);
          },
        }),
      }),
    },
  };
});

import { UI_CALLS_RETENTION_HOURS, reapUiCalls, summariseUiCallsReap } from './ui-calls-reap';

const NOW = new Date('2026-10-28T00:00:00.000Z');
const CUTOFF = '2026-10-27T00:00:00.000Z';

beforeEach(() => {
  h.statements.length = 0;
  h.results.length = 0;
});

describe('ui-calls-reap', () => {
  it('keeps 24 hours', () => {
    expect(UI_CALLS_RETENTION_HOURS).toBe(24);
  });

  it('deletes in batches past the cutoff until a short batch', async () => {
    h.results.push(new Array(10_000).fill({ id: 1 }), [{ id: 2 }]);
    expect(await reapUiCalls({ now: NOW })).toEqual({ deleted: 10_001 });
    expect(h.statements).toHaveLength(2);
    for (const s of h.statements) {
      expect(s.sql).toMatch(
        /^delete from "ui_calls" where "ui_calls"\."id" in \( select id from ui_calls where created_at < \$1::timestamptz limit \$2\) returning "id"$/,
      );
      expect(s.params).toEqual([CUTOFF, 10_000]);
    }
  });

  it('a dry run counts and deletes nothing', async () => {
    h.results.push([{ n: 5 }]);
    expect(await reapUiCalls({ now: NOW, dryRun: true })).toEqual({ deleted: 5 });
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0]!.sql).toMatch(/^select count\(\*\)::int as n from ui_calls/);
    expect(h.statements[0]!.params).toEqual([CUTOFF]);
  });

  it('summarises for the run row', () => {
    expect(summariseUiCallsReap({ deleted: 0 })).toBe('nothing to reap');
    expect(summariseUiCallsReap({ deleted: 3 })).toBe('deleted 3 agent UI call row(s)');
  });
});
