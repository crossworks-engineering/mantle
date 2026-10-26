/**
 * The access matrix is complete and never grants what must stay admin
 * (member logins Phase 0b). Pure: the live grants are checked by
 * access-matrix.db.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Table, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import {
  ACCESS_MATRIX,
  DRAFT_COLUMNS,
  NEVER_GRANTED_COLUMNS,
  SCOPED_SYSTEM_WRITE,
  WRITE_ROLE_TABLES,
  userReadFor,
  userGrantStatements,
} from './access-matrix';

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
      const read = userReadFor(t);
      if (read === 'none' || read === 'all') continue;
      const cols = Object.values(getTableColumns(byName.get(t.table)!)).map((c) => c.name);
      for (const c of read) expect(cols, `${t.table}.${c}`).toContain(c);
    }
  });

  it('never grants a draft column or a login secret', () => {
    for (const [table, banned] of Object.entries(NEVER_GRANTED_COLUMNS)) {
      const read = userReadFor(ACCESS_MATRIX.find((t) => t.table === table)!);
      expect(read, `${table} must name its columns`).not.toBe('all');
      if (read === 'none') continue;
      for (const c of banned) expect(read, `${table}.${c}`).not.toContain(c);
    }
  });

  it('grants the workspace role the draft columns of the item tables and no login secret (W6a)', () => {
    for (const t of ACCESS_MATRIX) {
      const read = userReadFor(t);
      if (!Array.isArray(read)) continue;
      for (const [table, banned] of Object.entries(NEVER_GRANTED_COLUMNS)) {
        if (table !== t.table) continue;
        const drafts = DRAFT_COLUMNS[table] ?? [];
        for (const c of banned) {
          if (drafts.includes(c)) expect(read, `${table}.${c}`).toContain(c);
          else expect(read, `${table}.${c}`).not.toContain(c);
        }
      }
    }
    expect(Object.keys(DRAFT_COLUMNS).sort()).toEqual([
      'public.apps',
      'public.draws',
      'public.pages',
      'public.tables',
    ]);
  });

  it('never grants credentials or the archived login secrets', () => {
    // Emails, chat history and the graph are read by the workspace role
    // under their row rules since W6a; these never are.
    const adminForever = [
      'public.api_keys',
      'public.secrets',
      'public.email_accounts',
      'public.telegram_messages',
      'public.oauth_access_tokens',
      'public.mobile_tokens',
      'public.member_invites',
      'public.archive_client_logins',
      'public.archive_client_workspace_users',
      'public.archive_client_signin_codes',
      'public.archive_mcp_login_tokens',
    ];
    for (const table of adminForever) {
      expect(userReadFor(ACCESS_MATRIX.find((t) => t.table === table)!), table).toBe('none');
    }
  });

  it('a row rule of its own only where the workspace role reads', () => {
    for (const t of ACCESS_MATRIX) {
      if (t.userRule) expect(userReadFor(t), t.table).not.toBe('none');
    }
  });

  it('renders SELECT-only grants, column lists where named', () => {
    const stmts = userGrantStatements();
    expect(stmts.every((s) => s.startsWith('GRANT SELECT'))).toBe(true);
    expect(stmts).toContain('GRANT SELECT ON "public"."nodes" TO "mantle_view_user"');
    expect(stmts).toContain(
      'GRANT SELECT ("id", "is_owner", "created_at") ON "auth"."users" TO "mantle_view_user"',
    );
    expect(stmts.find((s) => s.includes('"public"."pages"'))).toMatch(
      /^GRANT SELECT \("node_id", "doc", /,
    );
  });

  // Plan v3.2 S4a: the list S4b reads before it refuses a scoped typed
  // write to a table the write role does not hold.
  it('names a reason for every scoped system write, on no write-role table, and keeps the list small', () => {
    const listed = Object.entries(SCOPED_SYSTEM_WRITE);
    for (const [table, why] of listed) {
      expect(why.trim().length, `${table}: an empty scopedSystemWrite reason`).toBeGreaterThan(20);
      expect(WRITE_ROLE_TABLES, `${table}: a write-role table needs no reason`).not.toContain(
        table,
      );
    }
    // The pin (scripts/arch-scoreboard.pins.json, scopedSystemWriteTables)
    // only goes down, or up with a reviewed note: a new table on the list is
    // a reviewed decision, never a quiet way past S4b.
    const pins = JSON.parse(
      readFileSync(new URL('../../../scripts/arch-scoreboard.pins.json', import.meta.url), 'utf8'),
    ) as { scopedSystemWriteTables?: number };
    expect(listed.length).toBe(pins.scopedSystemWriteTables);
    expect(listed.length).toBeLessThanOrEqual(5);
  });
});
