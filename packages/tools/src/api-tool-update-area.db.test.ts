/**
 * api_tool_update's own system tables (tools, tool_groups, audit_log) on a
 * real, migrated Postgres, in a login's write request (the owner's MCP
 * client and Tools console run it there): a login without the connectors
 * area is still refused by the gate and nothing is written; an Admin user
 * with it changes the tool, joins it to a group and switches External
 * access off through areaSystem, so none of those writes is a fail-open
 * typed-write hit (docs/fail-open.md).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/api-tool-update-area.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('api_tool_update writes its own system tables through areaSystem', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']> | undefined;
  let m: typeof import('@mantle/db');
  let fo: Ts;
  let dispatch: typeof import('./dispatch');
  let callers: typeof import('./gate-callers');
  const admin = randomUUID();
  const member = randomUUID();
  const tag = `atu${randomUUID().slice(0, 6)}`;
  const slug = `${tag}_tool`;
  const group = `${tag}-group`;
  let anchor = '';

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    su = ts.superuserClient(scratch.url);
    await su`insert into auth.users (id, email, password_hash, role) values
      (${admin}, ${`${tag}-a@example.invalid`}, 'x', 'admin'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member')`;
    anchor = await ts.ensureTestAnchor(su);
    await ts.ensureAdminUsers(su, [admin]);
    const [team] = await su<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${anchor}, ${`${tag} Team`}) returning id::text`;
    await su`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team!.id}, ${member}, true)`;
    const http = JSON.stringify({ kind: 'http', url: 'https://api.example.test/x', method: 'GET' });
    await su`insert into tools (owner_id, slug, name, description, handler, requires_confirm)
      values (${anchor}, ${slug}, 'n', 'd', ${http}::jsonb, false)`;
    await su`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${group}, 'g', '{}', true)`;
    m = await import('@mantle/db');
    fo = ts;
    dispatch = await import('./dispatch');
    callers = await import('./gate-callers');
    await import('./gate-narrowers');
    await import('./builtins');
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  /** api_tool_update through the gate, in `login`'s write request. */
  const update = (login: string, input: Record<string, unknown>) =>
    m.runInRequestSlot(async () => {
      const scope = await m.loginScopeFor(login);
      expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
      return dispatch.dispatchTool(
        {
          slug: 'api_tool_update',
          handler: { kind: 'builtin', ref: 'api_tool_update' },
          inputSchema: {},
        } as unknown as Tool,
        { slug, ...input },
        { ownerId: anchor, surface: { kind: 'web' }, caller: callers.ownerWebCaller() },
      );
    });
  const toolRow = async () =>
    (
      await su!<{ enabled: boolean; in_group: boolean }[]>`
        select t.enabled, exists (select 1 from tool_groups g
          where g.owner_id = ${anchor} and g.slug = ${group} and t.slug = any(g.tool_slugs)) as in_group
          from tools t where t.owner_id = ${anchor} and t.slug = ${slug}`
    )[0];

  it('a login without the connectors area: refused by the gate, nothing written', async () => {
    fo.resetFailOpenForTest();
    const res = await update(member, { enabled: false, group_slug: group });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : String(res.error)).toMatch(/manages the brain's connectors/);
    expect(await toolRow()).toEqual({ enabled: true, in_group: false });
    expect(fo.takeFailOpenHits()).toEqual([]);
  });

  it('an Admin user with the area: the tool, its group and External access change, no fail-open hit', async () => {
    fo.resetFailOpenForTest();
    const res = await update(admin, { enabled: false, group_slug: group, external_access: false });
    expect(res.ok, res.ok ? '' : String(res.error)).toBe(true);
    expect(await toolRow()).toEqual({ enabled: false, in_group: true });
    // The switch's audit row is written after the answer: wait for it.
    let audit = 0;
    for (let i = 0; i < 50 && audit === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const [row] = await su!<{ n: number }[]>`select count(*)::int as n from audit_log
        where action = 'tool.external_access.off' and detail->>'slug' = ${slug}`;
      audit = row?.n ?? 0;
    }
    expect(audit).toBe(1);
    expect(fo.takeFailOpenHits()).toEqual([]);
    // The same writes as the caller's own scoped write still count: the
    // hit the fix removed (gateway/write-route.ts typedWrite).
    await m.runInRequestSlot(async () => {
      m.enterRequestScope(await m.loginScopeFor(admin), { writes: true, drafts: false });
      await m.db
        .update(m.tools)
        .set({ updatedAt: new Date() })
        .where(sql`false`);
    });
    expect(fo.takeFailOpenHits()).toEqual([
      { site: 'typed-write', actor: 'login', table: 'public.tools' },
    ]);
  });
});
