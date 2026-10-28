/**
 * The MCP call log on a real, migrated Postgres (Journal v3 J8, 0345): a
 * row is written from a login's request scope, a read or a write one (the
 * narrow route: system:audit:mcp-call, INSERT only); the work session is
 * the login's last call's within 30 minutes, else a new one; a login reads
 * its own rows and an Admin user's scope every row (the row rule); no
 * login's scope writes the table itself; and 0345's rollback takes it off
 * the ledger only. (The 90-day reap: server/web/lib/maintenance/
 * mcp-calls-reap.test.ts.)
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/mcp-call-log.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, ensureAdminUsers } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the MCP call log (0345)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let v: typeof import('./viewer');
  const admin = randomUUID();
  const member = randomUUID();
  let adminWs = '';
  const memberWs = randomUUID();

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    for (const [id, role] of [
      [admin, 'admin'],
      [member, 'member'],
    ] as const) {
      await su`insert into auth.users (id, email, password_hash, role)
        values (${id}, ${`mcp-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
    }
    adminWs = await ensureAdminUsers(su, [admin]);
    m = await import('./index');
    v = await import('./viewer');
    await m.systemDb.execute(sql`select 1`);
    m.startCallAudit({ sink: () => {} });
  }, 120_000);

  afterAll(async () => {
    m?.stopCallAudit();
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** Run `fn` in `login`'s request scope over `ws`. */
  const inRequest = <T>(login: string, ws: string, writes: boolean, fn: () => Promise<T>) =>
    v.runInRequestSlot(async () => {
      const scope = Object.freeze({
        kind: 'user' as const,
        loginId: login,
        ws: Object.freeze([ws]),
        modWs: Object.freeze([]),
      });
      expect(v.enterRequestScope(scope, { writes, drafts: false })).toBe(true);
      return fn();
    });

  const entry = (loginId: string, tool: string): import('./index').McpCallEntry => ({
    loginId,
    via: 'oauth',
    workspaceId: null,
    tool,
    args: { id: 'x' },
    ok: true,
    error: null,
    durationMs: 12,
    itemIds: [randomUUID()],
    resultBytes: 345,
  });

  const rowsOf = (login: string) =>
    su<{ tool: string; session_id: string; created_at: Date }[]>`
      select tool, session_id::text, created_at from mcp_calls
       where login_id = ${login} order by created_at`;

  it('a row is written from a read scope and from a write scope', async () => {
    await inRequest(member, memberWs, false, async () => m.recordMcpCall(entry(member, 'm1')));
    await inRequest(member, memberWs, true, async () => m.recordMcpCall(entry(member, 'm2')));
    await m.mcpCallsSettled();
    expect(m.mcpCallLogStats().failed).toBe(0);
    const rows = await rowsOf(member);
    expect(rows.map((r) => r.tool)).toEqual(['m1', 'm2']);
    const [full] = await su<
      { via: string; args: unknown; duration_ms: number; result_bytes: number; n: number }[]
    >`select via, args, duration_ms, result_bytes, cardinality(item_ids) as n
        from mcp_calls where login_id = ${member} and tool = 'm1'`;
    expect(full).toEqual({
      via: 'oauth',
      args: { id: 'x' },
      duration_ms: 12,
      result_bytes: 345,
      n: 1,
    });
  });

  it('one work session per login while the calls stay within 30 minutes', async () => {
    const rows = await rowsOf(member);
    expect(new Set(rows.map((r) => r.session_id)).size).toBe(1);
    // The member's last call 31 minutes ago: the next call opens a session.
    await su`update mcp_calls set created_at = created_at - interval '31 minutes'
              where login_id = ${member}`;
    await inRequest(member, memberWs, false, async () => m.recordMcpCall(entry(member, 'm3')));
    await m.runAsSystem('test:mcp-call-log', async () => m.recordMcpCall(entry(admin, 'a1')));
    await m.mcpCallsSettled();
    const after = await rowsOf(member);
    expect(after.map((r) => r.tool)).toEqual(['m1', 'm2', 'm3']);
    expect(after[2]!.session_id).not.toBe(after[0]!.session_id);
    // Another login never joins it.
    const [a] = await rowsOf(admin);
    expect([after[0]!.session_id, after[2]!.session_id]).not.toContain(a!.session_id);
  });

  it('a login reads its own rows; an Admin user every row', async () => {
    const mine = await inRequest(member, memberWs, false, () => m.listMcpCalls());
    expect(new Set(mine.map((r) => r.loginId))).toEqual(new Set([member]));
    expect(mine).toHaveLength(3);
    // Asking for another login's rows gives none.
    expect(
      await inRequest(member, memberWs, false, () => m.listMcpCalls({ loginId: admin })),
    ).toEqual([]);
    const all = await inRequest(admin, adminWs, false, () => m.listMcpCalls());
    expect(new Set(all.map((r) => r.loginId))).toEqual(new Set([member, admin]));
    // Newest first, and the filters narrow.
    const one = await inRequest(admin, adminWs, false, () =>
      m.listMcpCalls({ loginId: member, tool: 'm3' }),
    );
    expect(one.map((r) => r.tool)).toEqual(['m3']);
  });

  it("no login's scope writes the table itself", async () => {
    const failed = await inRequest(member, memberWs, true, async () =>
      Promise.resolve()
        .then(() =>
          m.db.insert(m.mcpCalls).values({
            loginId: member,
            via: 'oauth',
            sessionId: randomUUID(),
            tool: 'forged',
            args: {},
            ok: true,
            durationMs: 0,
            resultBytes: 0,
          }),
        )
        .then(
          () => null,
          (err: unknown) => err,
        ),
    );
    expect(failed).toBeInstanceOf(v.SystemWorkRequiredError);
    const [n] = await su<
      { n: number }[]
    >`select count(*)::int as n from mcp_calls where tool = 'forged'`;
    expect(n!.n).toBe(0);
  });

  it('0345: the rollback takes it off the ledger and keeps the table', async () => {
    const revert = readFileSync(
      new globalThis.URL('../rollback/0345_mcp_calls.revert.sql', import.meta.url),
      'utf8',
    );
    const seen: number[] = [];
    await su
      .begin(async (tx) => {
        // A scratch copy has no ledger: the revert's own DELETE needs one.
        await tx`create schema if not exists "drizzle"`;
        await tx`create table if not exists "drizzle"."__drizzle_migrations" (
          id serial primary key, hash text not null, created_at bigint)`;
        await tx`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
          values ('0345', 1790200860000)`;
        await tx.unsafe(revert);
        seen.push(
          (
            await tx<{ n: number }[]>`select count(*)::int as n
              from "drizzle"."__drizzle_migrations" where created_at = 1790200860000`
          )[0]!.n,
        );
        seen.push((await tx<{ n: number }[]>`select count(*)::int as n from mcp_calls`)[0]!.n);
        throw new Error('roll back');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== 'roll back') throw err;
      });
    // Off the ledger; the rows stay.
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeGreaterThan(0);
  });
});
