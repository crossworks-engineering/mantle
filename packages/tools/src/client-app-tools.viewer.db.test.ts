/**
 * The client tool broker's rules on a real, migrated Postgres (client logins
 * C6, docs/client-logins.md section 10). A client's run of an app may call a
 * tool only when the app declares it, it is one of the client tools
 * (CLIENT_APP_TOOL_SLUGS) under its own builtin, a read-only built-in without
 * confirmation, and an ENABLED tool group at client level (or public) holds
 * it. A brain-wide read tool (search_chunks, page_get) is refused even when
 * a client-level group holds it: its summaries and chunks are built from
 * text above client level. Checked per call, so a group raised to team or
 * switched off refuses the next call.
 *
 * Every group below holds every tool, so only the rule under test refuses.
 * Seeds its own rows on a random owner; removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/client-app-tools.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client app tool broker rules', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let ct: typeof import('./client-app-tools');
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `ctools-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const DECLARED = [
    'client_shared_list',
    'client_shared_search',
    'client_shared_open',
    'search_chunks',
    'page_get',
    'my_items_list',
    'client_request_create',
    'shared_alias',
  ];
  const ALL = [...DECLARED];

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const verdict = (slug: string, declared = DECLARED) =>
    ct.clientAppToolVerdict(anchor, declared, slug);
  const group = (level: string, enabled = true) =>
    exec(
      sqlTag`update tool_groups set audience = ${level}, enabled = ${enabled} where owner_id = ${anchor} and slug = 'g-client'`,
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ct = await import('./client-app-tools');
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
        (${anchor}, 'client_shared_list', 'n', 'd', ${b('client_shared_list')}::jsonb, false),
        (${anchor}, 'client_shared_search', 'n', 'd', ${b('client_shared_search')}::jsonb, true),
        (${anchor}, 'client_shared_open', 'n', 'd', ${b('page_get')}::jsonb, false),
        (${anchor}, 'search_chunks', 'n', 'd', ${b('search_chunks')}::jsonb, false),
        (${anchor}, 'page_get', 'n', 'd', ${b('page_get')}::jsonb, false),
        (${anchor}, 'my_items_list', 'n', 'd', ${b('my_items_list')}::jsonb, false),
        (${anchor}, 'client_request_create', 'n', 'd', ${b('client_request_create')}::jsonb, false),
        (${anchor}, 'shared_alias', 'n', 'd', ${b('client_shared_list')}::jsonb, false)`);
    await exec(sqlTag`
      insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled) values
        (${anchor}, 'g-client', 'g', ${`{${ALL.join(',')}}`}::text[], 'client', true)`);
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from tool_groups where owner_id = ${anchor}`);
    await exec(sqlTag`delete from tools where owner_id = ${anchor}`);
    await exec(sqlTag`delete from spaces where login_id = ${anchor}`);
    await exec(sqlTag`delete from auth.users where id = ${anchor}`);
    await m.closeDb();
  }, 60_000);

  it('allows a declared client tool from an enabled client-level group', async () => {
    const v = await verdict('client_shared_list');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.tool.slug).toBe('client_shared_list');
  });

  it('refuses a slug the app does not declare, even a client tool', async () => {
    expect(await verdict('client_shared_list', ['client_shared_open'])).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('refuses a brain-wide read tool even when a client-level group holds it', async () => {
    for (const slug of ['search_chunks', 'page_get']) {
      expect(await verdict(slug), slug).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("refuses the client's private-item reader and the client chat's write", async () => {
    for (const slug of ['my_items_list', 'client_request_create']) {
      expect(await verdict(slug), slug).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('refuses a tool that needs confirmation', async () => {
    expect(await verdict('client_shared_search')).toMatchObject({ ok: false, status: 403 });
  });

  it('reads the handler too: a client slug over another builtin, an alias of a client tool', async () => {
    // client_shared_open here runs page_get: refused by its handler.
    expect(await verdict('client_shared_open')).toMatchObject({ ok: false, status: 403 });
    // An alias slug over client_shared_list: refused by its slug.
    expect(await verdict('shared_alias')).toMatchObject({ ok: false, status: 403 });
  });

  it('checks the group at call time: raised to team, or switched off, refuses the next call', async () => {
    try {
      await group('team');
      expect(await verdict('client_shared_list')).toMatchObject({ ok: false, status: 403 });
      await group('client', false);
      expect(await verdict('client_shared_list')).toMatchObject({ ok: false, status: 403 });
      // A public group is below client: a client reads it.
      await group('public');
      expect((await verdict('client_shared_list')).ok).toBe(true);
    } finally {
      await group('client');
    }
  });
});
