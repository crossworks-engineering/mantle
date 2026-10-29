/**
 * api_tool_update's own system tables (tools, tool_groups, audit_log) on a
 * real, migrated Postgres, in a login's write request (the owner's MCP
 * client and Tools console run it there): a login without the connectors
 * area is still refused by the gate and nothing is written; an Admin user
 * with it changes the tool, joins it to a group and switches External
 * access off through areaSystem, so none of those writes is a scoped
 * system write, which is refused (docs/fail-open.md).
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
  let dispatch: typeof import('./dispatch');
  let callers: typeof import('./gate-callers');
  const admin = randomUUID();
  const member = randomUUID();
  // A user of Admin whose limits switch the connectors area off.
  const limited = randomUUID();
  const tag = `atu${randomUUID().slice(0, 6)}`;
  const slug = `${tag}_tool`;
  // A tool whose templates name a vault key: its update reads the vault.
  const secretSlug = `${tag}_secret_tool`;
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
      (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member'),
      (${limited}, ${`${tag}-l@example.invalid`}, 'x', 'admin')`;
    anchor = await ts.ensureTestAnchor(su);
    const adminWs = await ts.ensureAdminUsers(su, [admin]);
    await su`insert into workspace_users (workspace_id, login_id, moderator, limits)
      values (${adminWs}, ${limited}, false, '{"areas":{"connectors":false}}'::jsonb)`;
    const [team] = await su<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${anchor}, ${`${tag} Team`}) returning id::text`;
    await su`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team!.id}, ${member}, true)`;
    const http = JSON.stringify({ kind: 'http', url: 'https://api.example.test/x', method: 'GET' });
    await su`insert into tools (owner_id, slug, name, description, handler, requires_confirm)
      values (${anchor}, ${slug}, 'n', 'd', ${http}::jsonb, false)`;
    const withSecret = JSON.stringify({
      kind: 'http',
      url: 'https://api.example.test/y',
      method: 'GET',
      headers: { Authorization: 'Bearer {{secret:example-token}}' },
    });
    await su`insert into tools (owner_id, slug, name, description, handler, requires_confirm)
      values (${anchor}, ${secretSlug}, 'n', 'd', ${withSecret}::jsonb, false)`;
    await su`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${group}, 'g', '{}', true)`;
    m = await import('@mantle/db');
    // The login write pool, as web and api open it: a login's scoped work
    // runs on the write role, which does not read the key vault.
    m.openLoginWritePool({ max: 2 });
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
    // A member (no Admin workspace), and an Admin user whose limits switch
    // the area off.
    const outside = await update(member, { enabled: false, group_slug: group });
    expect(outside.ok).toBe(false);
    expect(outside.ok ? '' : String(outside.error)).toMatch(/belongs to the Admin workspace/);
    const off = await update(limited, { enabled: false, group_slug: group });
    expect(off.ok).toBe(false);
    expect(off.ok ? '' : String(off.error)).toMatch(/manages the brain's connectors/);
    expect(await toolRow()).toEqual({ enabled: true, in_group: false });
  });

  it('an Admin user with the area: the tool, its group and External access change', async () => {
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
    // The same write as the caller's own scoped write is refused
    // (gateway/write-route.ts typedWrite, plan v3.2 S4b).
    const refused = await m.runInRequestSlot(async () => {
      m.enterRequestScope(await m.loginScopeFor(admin), { writes: true, drafts: false });
      return Promise.resolve()
        .then(() =>
          m.db
            .update(m.tools)
            .set({ updatedAt: new Date() })
            .where(sql`false`),
        )
        .then(
          () => null,
          (err: unknown) => err as Error,
        );
    });
    expect(refused?.name).toBe('SystemWorkRequiredError');
    expect(refused?.message).toMatch(/public\.tools/);
  });
  it('an Admin user updates a tool that names a vault key in a turn (an MCP call): the vault is read in the area, not refused', async () => {
    // A turn runs its reads on the scoped role, which may not read the
    // key vault; the update's vault check is the connectors area's.
    const scope = await m.loginScopeFor(admin);
    const res = await m.withTurnScope(
      scope,
      () =>
        dispatch.dispatchTool(
          {
            slug: 'api_tool_update',
            handler: { kind: 'builtin', ref: 'api_tool_update' },
            inputSchema: {},
          } as unknown as Tool,
          { slug: secretSlug, description: 'a new description' },
          {
            ownerId: anchor,
            surface: { kind: 'web', loginId: admin },
            caller: callers.turnCaller(),
          },
        ),
      { writes: true },
    );
    expect(res.ok, res.ok ? '' : String(res.error)).toBe(true);
    const [row] = await su!<{ description: string }[]>`
      select description from tools where owner_id = ${anchor} and slug = ${secretSlug}`;
    expect(row?.description).toBe('a new description');
  });
});
