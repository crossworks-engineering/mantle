/**
 * The member tool broker's rules on a real, migrated Postgres (member logins
 * Phase 4b, plan v3.1 section 4a). A member's run of an app may call a tool
 * only when the app declares it, it is a built-in without confirmation, it is
 * not on the refused list, and an ENABLED tool group at team level or lower
 * holds it. Checked per call, so a group raised to admin or switched off
 * refuses the next call. A dispatch on the team role reads only team items.
 * `app_tools_set` warns with the same words.
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
    dispatch = await import('./dispatch');
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
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled) values
        (${anchor}, 'g-team', 'g', ARRAY['note_list','shell_thing','confirm_thing','my_items_list','page_list','quick_sum','note_create'], 'team', true),
        (${anchor}, 'g-admin', 'g', ARRAY['admin_only','note_list'], 'admin', true),
        (${anchor}, 'g-off', 'g', ARRAY['off_group'], 'team', false)`);
    await exec(sqlTag`
      insert into nodes (owner_id, type, title, path, audience, data) values
        (${anchor}, 'note', ${`${tag} team note`}, 'notes', 'team', '{"content":"t"}'::jsonb),
        (${anchor}, 'note', ${`${tag} admin note`}, 'notes', 'admin', '{"content":"a"}'::jsonb)`);
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience) values
        (${appId}, ${anchor}, 'app', ${`${tag} app`}, 'apps', 'team')`);
    await exec(sqlTag`insert into apps (node_id) values (${appId})`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from nodes where owner_id = ${anchor}`);
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

  it('refuses a tool held only by an admin-level group', async () => {
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

  it('checks at call time: a group raised to admin refuses the next call', async () => {
    expect((await verdict('page_list')).ok).toBe(true);
    await exec(
      sqlTag`update tool_groups set audience = 'admin' where owner_id = ${anchor} and slug = 'g-team'`,
    );
    try {
      expect(await verdict('page_list')).toMatchObject({ ok: false, status: 403 });
    } finally {
      await exec(
        sqlTag`update tool_groups set audience = 'team' where owner_id = ${anchor} and slug = 'g-team'`,
      );
    }
  });

  it('dispatches on the team role: row security applies, unlike the admin pool', async () => {
    // Row security on the team role is keyed on the box's one brain
    // (mantle_brain_id()), which this test's brain is not: on the team role
    // the tool sees none of its notes, on the admin pool it sees both. That
    // difference is the proof the call ran on the limited role.
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
    const asTeam = await m.withViewer('team', run);
    expect(asTeam.ok).toBe(true);
    expect(titles(asTeam)).toEqual([]);
    const asAdmin = await run();
    expect(titles(asAdmin)).toEqual(
      expect.arrayContaining([`${tag} team note`, `${tag} admin note`]),
    );
  });

  it('app_tools_set warns about every tool members of a team app cannot use', async () => {
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

    // The same app at admin level: only admins run it, so no warnings.
    await exec(sqlTag`update nodes set audience = 'admin' where id = ${appId}`);
    const quiet = await def.handler(
      { id: appId, tool_slugs: ['admin_only'] },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(quiet.ok && (quiet.output as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it('access_set on an app warns about the tools members would be refused', async () => {
    const def = builtins.BUILTIN_TOOLS.find((t) => t.slug === 'access_set');
    if (!def) throw new Error('access_set is not a builtin any more');
    await exec(
      sqlTag`update apps set manifest = '{"toolSlugs":["note_list","note_create"]}'::jsonb where node_id = ${appId}`,
    );
    const res = await def.handler(
      { node_id: appId, level: 'team' },
      { ownerId: anchor, surface: { kind: 'web' } },
    );
    expect(res.ok).toBe(true);
    const warnings = (res.ok ? (res.output as { warnings?: string[] }).warnings : []) ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'note_create'");
  });
});
