/**
 * The member tool broker's rules on a real, migrated Postgres (member logins
 * Phase 4b, plan v3.1 section 4a). A member's run of an app may call a tool
 * only when the app declares it, it is a built-in without confirmation, it is
 * not on the refused list, and an ENABLED tool group at team level or lower
 * holds it. Checked per call, so a group raised to admin or switched off
 * refuses the next call. A dispatch in a workspace scope reads only what the
 * scope holds.
 * `app_tools_set` warns with the same words when a workspace other than
 * Admin holds the app (its grants, workspaces W5b2 plan R2).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/member-app-tools.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('member app tool broker rules', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let mt: typeof import('./member-app-tools');
  let dispatch: typeof import('./dispatch');
  let builtins: typeof import('./builtins');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `mtools-${randomUUID().slice(0, 8)}`;
  // A brain of this test's own (test files run in parallel).
  const anchor = randomUUID();
  const appId = randomUUID();
  const ws = { admin: randomUUID(), team: randomUUID() };
  const DECLARED = [
    'note_list',
    'page_list',
    'shell_thing',
    'confirm_thing',
    'admin_only',
    'my_items_list',
    'off_group',
    'quick_sum',
    'note_create',
  ];

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const verdict = (slug: string, declared = DECLARED) =>
    mt.memberAppToolVerdict(anchor, declared, slug);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    mt = await import('./member-app-tools');
    dispatch = brokerCallDispatch(await import('./dispatch'), await import('./gate-callers'));
    await import('./gate-narrowers');
    builtins = await import('./builtins');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);

    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role)
      values (${anchor}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await exec(
      sqlTag`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})`,
    );
    const b = (ref: string) => JSON.stringify({ kind: 'builtin', ref });
    await exec(sqlTag`
      insert into tools (owner_id, slug, name, description, handler, requires_confirm) values
        (${anchor}, 'note_list', 'n', 'd', ${b('note_list')}::jsonb, false),
        (${anchor}, 'page_list', 'n', 'd', ${b('page_list')}::jsonb, false),
        (${anchor}, 'shell_thing', 'n', 'd', '{"kind":"shell","cmd":"true"}'::jsonb, false),
        (${anchor}, 'confirm_thing', 'n', 'd', ${b('note_list')}::jsonb, true),
        (${anchor}, 'admin_only', 'n', 'd', ${b('note_list')}::jsonb, false),
        (${anchor}, 'my_items_list', 'n', 'd', ${b('my_items_list')}::jsonb, false),
        (${anchor}, 'off_group', 'n', 'd', ${b('note_list')}::jsonb, false),
        (${anchor}, 'quick_sum', 'n', 'd', ${b('summarize_text')}::jsonb, false),
        (${anchor}, 'note_create', 'n', 'd', ${b('note_create')}::jsonb, false)`);
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, admin_only) values
        (${anchor}, 'g-team', 'g', ARRAY['note_list','shell_thing','confirm_thing','my_items_list','page_list','quick_sum','note_create'], 'team', true, false),
        (${anchor}, 'g-admin', 'g', ARRAY['admin_only','note_list'], 'admin', true, true),
        (${anchor}, 'g-off', 'g', ARRAY['off_group'], 'team', false, false)`);
    await exec(sqlTag`
      insert into nodes (owner_id, type, title, path, audience, data) values
        (${anchor}, 'note', ${`${tag} team note`}, 'notes', 'team', '{"content":"t"}'::jsonb),
        (${anchor}, 'note', ${`${tag} admin note`}, 'notes', 'admin', '{"content":"a"}'::jsonb)`);
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${appId}, ${anchor}, 'app', ${`${tag} app`}, 'apps', 'team')`);
    await exec(sqlTag`insert into apps (node_id) values (${appId})`);
    await exec(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
        (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null)`);
    await m.withHeads([appId], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write, is_home) values
        (${appId}, ${ws.admin}, false, true), (${appId}, ${ws.team}, true, false)`),
    );
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from item_grants where node_id = ${appId}`);
    await exec(sqlTag`delete from nodes where owner_id = ${anchor}`);
    await exec(sqlTag`delete from workspaces where owner_id = ${anchor}`);
    await exec(sqlTag`delete from spaces where login_id = ${anchor}`);
    await exec(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  it('allows a declared built-in from an enabled team-level group', async () => {
    const v = await verdict('note_list');
    expect(v.ok).toBe(true);
  });

  it('refuses a tool the app does not declare', async () => {
    expect(await verdict('note_list', ['page_list'])).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a tool held only by an adminOnly group (W7b: no levels)', async () => {
    expect(await verdict('admin_only')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a tool whose team-level group is switched off', async () => {
    expect(await verdict('off_group')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a non-builtin handler and a confirm-gated tool', async () => {
    expect(await verdict('shell_thing')).toMatchObject({ ok: false, status: 403 });
    expect(await verdict('confirm_thing')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a refused builtin under another slug (the rule reads the handler too)', async () => {
    expect(await verdict('quick_sum')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a builtin that writes, even from a team-level group', async () => {
    expect(await verdict('note_create')).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses the member's private-item readers even in a team group", async () => {
    expect(await verdict('my_items_list')).toMatchObject({ ok: false, status: 403 });
  });

  it('checks at call time: a group made adminOnly refuses the next call (W7b)', async () => {
    expect((await verdict('page_list')).ok).toBe(true);
    await exec(
      sqlTag`update tool_groups set admin_only = true where owner_id = ${anchor} and slug = 'g-team'`,
    );
    try {
      expect(await verdict('page_list')).toMatchObject({ ok: false, status: 403 });
    } finally {
      await exec(
        sqlTag`update tool_groups set admin_only = false where owner_id = ${anchor} and slug = 'g-team'`,
      );
    }
  });

  it('dispatches in a workspace scope: row security applies, unlike the admin pool', async () => {
    // A scope that holds no workspace (W8c: the level roles are gone) sees
    // none of the notes; the admin pool sees both. That difference is the
    // proof the call ran on the workspace role.
    const v = await verdict('note_list');
    if (!v.ok) throw new Error(v.reason);
    const run = () =>
      dispatch.dispatchTool(
        v.tool,
        {},
        { ownerId: anchor, surface: { kind: 'team', loginId: randomUUID(), privateReads: false } },
      );
    const titles = (res: Awaited<ReturnType<typeof run>>) =>
      (res.ok ? (res.output as { title: string }[]) : []).map((r) => r.title);
    const scoped = await m.withViewer({ agent: null }, run);
    expect(scoped.ok).toBe(true);
    expect(titles(scoped)).toEqual([]);
    const asAdmin = await run();
    expect(titles(asAdmin)).toEqual(
      expect.arrayContaining([`${tag} team note`, `${tag} admin note`]),
    );
  });

  it('app_tools_set warns about every tool members of an app Team holds cannot use', async () => {
    const def = builtins.BUILTIN_TOOLS.find((t) => t.slug === 'app_tools_set');
    if (!def) throw new Error('app_tools_set is not a builtin any more');
    const res = await def.handler(
      { id: appId, tool_slugs: ['note_list', 'admin_only', 'shell_thing'] },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(res.ok).toBe(true);
    const warnings = (res.ok ? (res.output as { warnings?: string[] }).warnings : []) ?? [];
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toContain("'admin_only'");
    expect(warnings.join(' ')).toContain("'shell_thing'");

    // The same app once only Admin holds it: only admins run it, so no
    // warnings (the level written on the row means nothing).
    await m.withHeads([appId], 'update', (tx) =>
      tx.execute(
        sqlTag`delete from item_grants where node_id = ${appId} and workspace_id = ${ws.team}`,
      ),
    );
    try {
      const quiet = await def.handler(
        { id: appId, tool_slugs: ['admin_only'] },
        { ownerId: anchor, surface: { kind: 'web' } },
      );
      expect(quiet.ok && (quiet.output as { warnings?: string[] }).warnings).toBeUndefined();
    } finally {
      await m.withHeads([appId], 'update', (tx) =>
        tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, write)
          values (${appId}, ${ws.team}, true)`),
      );
    }
  });
});

/** The dispatch module with each dispatchTool call named an app broker's
 *  caller for the surface it passes, unless it names its own (every entry
 *  names one since A5 step 3b; these calls stand for a broker's: a database
 *  error's text masked off the owner's web, as before). */
function brokerCallDispatch(
  real: typeof import('./dispatch'),
  callers: typeof import('./gate-callers'),
): typeof import('./dispatch') {
  return {
    ...real,
    dispatchTool: (tool, input, ctx, depth) =>
      real.dispatchTool(
        tool,
        input,
        {
          caller: callers.appBrokerCaller(ctx.surface ?? { kind: 'none' }, { ok: true, tool }),
          ...ctx,
        },
        depth,
      ),
  };
}
