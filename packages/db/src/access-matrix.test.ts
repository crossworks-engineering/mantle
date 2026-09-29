/**
 * The access matrix is complete and never grants what must stay admin
 * (member logins Phase 0b). Pure: the live grants are checked by
 * access-matrix.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Table, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import {
  ACCESS_MATRIX,
  NEVER_GRANTED_COLUMNS,
  readFor,
  ruleFor,
  viewerGrantStatements,
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
      'public.member_invites',
      'public.client_signin_codes',
      'public.client_signin_code_skips',
      'public.client_signin_sender_folders',
    ];
    for (const table of adminForever) {
      expect(ACCESS_MATRIX.find((t) => t.table === table)?.read, table).toBe('none');
    }
  });

  it('every readable table has a row rule, and every unreadable one has none', () => {
    for (const t of ACCESS_MATRIX) {
      for (const level of ['team', 'client', 'public'] as const) {
        const at = `${t.table} (${level})`;
        if (readFor(t, level) === 'none') expect(ruleFor(t, level), at).toBe('none');
        else expect(ruleFor(t, level), at).not.toBe('none');
      }
    }
  });

  it('only the client role differs from the shared matrix (client logins C1)', () => {
    for (const t of ACCESS_MATRIX) {
      expect(t.byRole?.team, t.table).toBeUndefined();
      expect(t.byRole?.public, t.table).toBeUndefined();
    }
    const client = (table: string) => ACCESS_MATRIX.find((t) => t.table === table)!;
    expect(ruleFor(client('public.agents'), 'client')).toBe('level-rows');
    expect(ruleFor(client('public.tool_groups'), 'client')).toBe('level-rows');
    expect(readFor(client('auth.users'), 'client')).toBe('none');
    // The team role still reads every agent: team delegation to admin agents.
    expect(ruleFor(client('public.agents'), 'team')).toBe('all-rows');
    // Audit A27: no embedding config (base URLs) and no owner name for the
    // client role; the team role unchanged.
    expect(readFor(client('public.embedding_config'), 'client')).toBe('none');
    expect(readFor(client('public.embedding_config'), 'team')).toBe('all');
    expect(readFor(client('public.profiles'), 'client')).toEqual(['user_id', 'preferences']);
    expect(readFor(client('public.profiles'), 'team')).toBe('all');
  });

  it('renders no grant on auth.users for the client role', () => {
    expect(viewerGrantStatements('client').some((s) => s.includes('"auth"."users"'))).toBe(false);
    expect(viewerGrantStatements('team').some((s) => s.includes('"auth"."users"'))).toBe(true);
  });

  it('renders SELECT-only grants, column lists where named', () => {
    const stmts = viewerGrantStatements('team');
    expect(stmts.every((s) => s.startsWith('GRANT SELECT'))).toBe(true);
    expect(stmts).toContain('GRANT SELECT ON "public"."nodes" TO "mantle_view_team"');
    expect(stmts.find((s) => s.includes('"public"."pages"'))).toMatch(
      /^GRANT SELECT \("node_id", "doc", /,
    );
  });
});
