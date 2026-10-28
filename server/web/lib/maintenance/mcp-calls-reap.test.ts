/**
 * The `mcp-calls-reap` sweep (Journal v3 J8): MCP call log rows go 90 days
 * after they were written, in batches until a short one; a dry run only
 * counts. The database is a double that records each statement.
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
  const { mcpCalls } =
    await vi.importActual<typeof import('@mantle/db/schema')>('@mantle/db/schema');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // The typed delete is built by drizzle itself and its text recorded.
  const builder = drizzle.mock();
  return {
    mcpCalls,
    MCP_CALLS_RETENTION_DAYS: 90,
    db: {
      execute: async (q: SQL) => {
        const { sql, params } = new PgDialect().sqlToQuery(q);
        return record(sql, params);
      },
      delete: (table: typeof mcpCalls) => ({
        where: (cond: SQL) => ({
          returning: async (cols: { id: typeof mcpCalls.id }) => {
            const { sql, params } = builder.delete(table).where(cond).returning(cols).toSQL();
            return record(sql, params);
          },
        }),
      }),
    },
  };
});

import { MCP_CALLS_RETENTION_DAYS, reapMcpCalls, summariseMcpCallsReap } from './mcp-calls-reap';

const NOW = new Date('2026-10-28T00:00:00.000Z');
const CUTOFF = '2026-07-30T00:00:00.000Z';

beforeEach(() => {
  h.statements.length = 0;
  h.results.length = 0;
});

describe('mcp-calls-reap', () => {
  it('keeps 90 days', () => {
    expect(MCP_CALLS_RETENTION_DAYS).toBe(90);
  });

  it('deletes in batches past the cutoff until a short batch', async () => {
    h.results.push(new Array(10_000).fill({ id: 1 }), [{ id: 2 }]);
    expect(await reapMcpCalls({ now: NOW })).toEqual({ deleted: 10_001 });
    expect(h.statements).toHaveLength(2);
    for (const s of h.statements) {
      expect(s.sql).toMatch(
        /^delete from "mcp_calls" where "mcp_calls"\."id" in \( select id from mcp_calls where created_at < \$1::timestamptz limit \$2\) returning "id"$/,
      );
      expect(s.params).toEqual([CUTOFF, 10_000]);
    }
  });

  it('a dry run counts and deletes nothing', async () => {
    h.results.push([{ n: 5 }]);
    expect(await reapMcpCalls({ now: NOW, dryRun: true })).toEqual({ deleted: 5 });
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0]!.sql).toMatch(/^select count\(\*\)::int as n from mcp_calls/);
    expect(h.statements[0]!.params).toEqual([CUTOFF]);
  });

  it('summarises for the run row', () => {
    expect(summariseMcpCallsReap({ deleted: 0 })).toBe('nothing to reap');
    expect(summariseMcpCallsReap({ deleted: 3 })).toBe('deleted 3 MCP call row(s)');
  });
});
