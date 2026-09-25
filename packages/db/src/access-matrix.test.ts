/**
 * The access matrix is complete and never grants what must stay admin
 * (member logins Phase 0b). Pure: the live grants are checked by
 * access-matrix.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Table, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { ACCESS_MATRIX, NEVER_GRANTED_COLUMNS, viewerGrantStatements } from './access-matrix';

const tables = Object.values(schema).filter((v) => is(v, Table)) as unknown as PgTable[];
const nameOf = (t: PgTable) => {
  const c = getTableConfig(t);
  return `${c.schema ?? 'public'}.${c.name}`;
};
const byName = new Map(tables.map((t) => [nameOf(t), t]));

describe('access matrix', () => {
  it('lists every Drizzle table exactly once, and nothing else', () => {
    const listed = ACCESS_MATRIX.map((t) => t.table);
    expect(new Set(listed).size, 'a table is listed twice').toBe(listed.length);
    expect([...listed].sort()).toEqual([...byName.keys()].sort());
  });

  it('names only real columns', () => {
    for (const t of ACCESS_MATRIX) {
      if (t.read === 'none' || t.read === 'all') continue;
      const cols = Object.values(getTableColumns(byName.get(t.table)!)).map((c) => c.name);
      for (const c of t.read) expect(cols, `${t.table}.${c}`).toContain(c);
    }
  });

  it('never grants a draft column or a login secret', () => {
    for (const [table, banned] of Object.entries(NEVER_GRANTED_COLUMNS)) {
      const entry = ACCESS_MATRIX.find((t) => t.table === table)!;
      expect(entry.read, `${table} must name its columns`).not.toBe('all');
      if (entry.read === 'none') continue;
      for (const c of banned) expect(entry.read, `${table}.${c}`).not.toContain(c);
    }
  });

  it('never grants the private corpus or credentials', () => {
    const adminForever = [
      'public.api_keys',
      'public.secrets',
      'public.emails',
      'public.email_accounts',
      'public.telegram_messages',
      'public.assistant_messages',
      'public.entities',
      'public.entity_edges',
      'public.oauth_access_tokens',
      'public.mobile_tokens',
    ];
    for (const table of adminForever) {
      expect(ACCESS_MATRIX.find((t) => t.table === table)?.read, table).toBe('none');
    }
  });

  it('every readable table has a row rule, and every unreadable one has none', () => {
    for (const t of ACCESS_MATRIX) {
      if (t.read === 'none') expect(t.rule, t.table).toBe('none');
      else expect(t.rule, t.table).not.toBe('none');
    }
  });

  it('renders SELECT-only grants, column lists where named', () => {
    const stmts = viewerGrantStatements('mantle_view_team');
    expect(stmts.every((s) => s.startsWith('GRANT SELECT'))).toBe(true);
    expect(stmts).toContain('GRANT SELECT ON "public"."nodes" TO "mantle_view_team"');
    expect(stmts.find((s) => s.includes('"public"."pages"'))).toMatch(
      /^GRANT SELECT \("node_id", "doc", /,
    );
  });
});
