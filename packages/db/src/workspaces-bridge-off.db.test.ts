/**
 * Workspaces W5b2 part B (migration 0261): the level bridge goes off and the
 * grants are the only truth. A scratch brain is migrated up to 0260, given
 * the world 0261 meets on a live box (levels set by the level triggers, the
 * workspaces migrated through the bridge, an old public app row with Write
 * on), then 0261 and every later migration run. Checked:
 *
 *  (a) no bridge row is left; a folder whose Team row came from its own
 *      level loses it; a Team row a folder share gave is derived from that
 *      folder; a public app's Team row has Write off; a "Removed here" row
 *      with no folder grant is gone (one against a folder grant stays);
 *  (g) the reach diff gains nothing; (h) archive_node_levels holds the
 *      levels as they were;
 *  (b) a level UPDATE is refused (55000), and passes under a named bypass;
 *  (c) a new item's home: Admin at the root, its folder's home inside a
 *      folder homed elsewhere (with the folder's rows), Admin for an
 *      Admin-only kind there;
 *  (d) an item re-owned into the brain gets the same default home;
 *  (e) the drift repair is a no-op;
 *  (f) a fresh install migrated later (mantle_ws_migrate_locked) ends with
 *      plain rows too.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-bridge-off.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, createScratchDatabaseBefore } from './test-support';
import { WORKSPACES_CHECK_SQL, parseWorkspacesCheck } from './workspaces-check';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Grant = { home: boolean; excluded: boolean; write: boolean; via: string | null };

describe.skipIf(!URL)('workspaces bridge off (0261)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const ids: Record<string, string> = {};
  let spaceA = '';
  let admin = '';
  let team = '';

  const node = async (
    key: string,
    type: string,
    path: string,
    audience = 'admin',
    o: string = owner,
  ) => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${o}, ${type}::node_type, ${key}, ${path}::ltree, ${audience})`;
    ids[key] = id;
    return id;
  };
  /** The item's rows by workspace name. */
  const grants = async (id: string): Promise<Record<string, Grant>> => {
    const rows = await sql<(Grant & { name: string })[]>`
      select w.name, g.is_home as home, g.excluded, g.write, g.via_folder_id::text as via
        from item_grants g join workspaces w on w.id = g.workspace_id
       where g.node_id = ${id}`;
    return Object.fromEntries(rows.map(({ name, ...g }) => [name, g]));
  };
  const derived = async (id: string) =>
    (
      await sql<{ r: string[]; w: string[]; h: string | null }[]>`
        select read_ws::text[] as r, write_ws::text[] as w, home_ws::text as h
          from nodes where id = ${id}`
    )[0]!;
  const bridgeRows = async () =>
    Number((await sql`select count(*) as n from item_grants where bridge`)[0]!.n);
  const reachFails = async (q: postgres.Sql = sql) =>
    q`select section, subject, metric, n::int as n from mantle_ws_reach_diff()
       where section = 'reach-fail'`;

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0261_workspaces_bridge_off');
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o@example.invalid', 'x', 'admin', true),
      (${member}, 'm@example.invalid', 'x', 'member', false)`;
    spaceA = (
      await sql<
        { id: string }[]
      >`select id from spaces where kind = 'personal' and login_id = ${member}`
    )[0]!.id;

    // The world before the switch: levels kept by the level triggers.
    await node('adminPage', 'page', 'pages');
    await node('teamPage', 'page', 'pages', 'team');
    await node('publicNote', 'note', 'notes', 'public');
    await node('email', 'email', 'emails');
    await node('folderOwn', 'branch', 'pages.own', 'team'); // its own level, no share
    await node('inOwn', 'page', 'pages.own');
    await node('folderShared', 'branch', 'pages.shared');
    await sql`update nodes set share_level = 'team' where id = ${ids.folderShared!}`;
    await node('inShared', 'page', 'pages.shared'); // team through the share
    await node('teamInShared', 'page', 'pages.shared', 'team');
    await node('removedKept', 'page', 'pages.shared');
    await node('embedded', 'file', 'files');
    await sql`insert into node_embeds (from_id, to_id) values (${ids.inShared!}, ${ids.embedded!})`;
    await node('teamApp', 'app', 'apps', 'team');
    await node('publicApp', 'app', 'apps', 'public');
    await sql`insert into apps (node_id, source, data_read_only) values
      (${ids.teamApp!}, '{}'::jsonb, false), (${ids.publicApp!}, '{}'::jsonb, false)`;
    await node('draft', 'page', 'pages', 'admin', spaceA);
    const [lv] = await sql<{ i: string | null; e: string | null }[]>`
      select (select inherited_level from nodes where id = ${ids.inShared!}) as i,
             (select embedded_level from nodes where id = ${ids.embedded!}) as e`;
    expect(lv).toEqual({ i: 'team', e: 'team' });

    // Migrated through the bridge, as 0252 did on a live box.
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const ws = await sql<{ id: string; key: string }[]>`
      select id::text as id, bridge_key as key from workspaces`;
    admin = ws.find((w) => w.key === 'admin')!.id;
    team = ws.find((w) => w.key === 'team')!.id;
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.acl_internal', 'on', true)`;
      // A "Removed here" against the folder's share (kept), and a public
      // app's Team row with Write on, as an older bridge left it.
      await tx`update item_grants set excluded = true, write = false
                where node_id = ${ids.removedKept!} and workspace_id = ${team}`;
      await tx`update item_grants set write = true
                where node_id = ${ids.publicApp!} and workspace_id = ${team}`;
    });
    expect(await bridgeRows()).toBeGreaterThan(0);
    expect((await grants(ids.folderOwn!)).Team).toMatchObject({ excluded: false });
    expect((await grants(ids.inOwn!)).Team).toMatchObject({ excluded: true });
    expect((await grants(ids.adminPage!)).Team).toMatchObject({ excluded: true });

    await scratch.migrateRest();
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('(a) the bridge rows become plain grants, narrowed three ways', async () => {
    expect(await bridgeRows()).toBe(0);
    // A folder's Team row from its own level goes, and with it the
    // "Removed here" of its item (no folder grant left to remove).
    expect(await grants(ids.folderOwn!)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
    expect(await grants(ids.inOwn!)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
    // A Team row the folder's share gave is derived from that folder; a
    // folder share and an item's own level stay plain rows.
    expect((await grants(ids.inShared!)).Team).toEqual({
      home: false,
      excluded: false,
      write: false,
      via: ids.folderShared,
    });
    expect((await grants(ids.folderShared!)).Team).toMatchObject({ excluded: false, via: null });
    expect((await grants(ids.teamInShared!)).Team).toMatchObject({ excluded: false, via: null });
    expect((await grants(ids.embedded!)).Team).toMatchObject({ excluded: false, via: null });
    // "Removed here" with no folder grant: gone; against one: kept.
    expect(Object.keys(await grants(ids.adminPage!))).toEqual(['Admin']);
    expect((await grants(ids.removedKept!)).Team).toMatchObject({ excluded: true });
    expect((await derived(ids.removedKept!)).r).toEqual([admin]);
    // A public app's Team row: Write off. A team app keeps its Write.
    expect(await grants(ids.publicApp!)).toEqual({
      Team: { home: true, excluded: false, write: false, via: null },
    });
    expect((await grants(ids.teamApp!)).Team).toMatchObject({ home: true, write: true });
    expect(Object.keys(await grants(ids.email!))).toEqual(['Admin']);
    expect(await grants(ids.draft!)).toEqual({});
    const [h] = await sql<{ n: number }[]>`
      select count(*)::int as n from nodes where owner_id = ${owner} and home_ws is null`;
    expect(h!.n).toBe(0);
    // The derived columns agree with the rows, and nothing is orphaned.
    const c = parseWorkspacesCheck((await sql.unsafe(WORKSPACES_CHECK_SQL))[0] as never);
    expect(c).toMatchObject({ grantDrift: 0, orphanGrants: 0, itemsWithoutHome: 0 });
    // The bridge's triggers are gone, the level upkeep's too.
    const trg = await sql<{ t: string }[]>`
      select tgname as t from pg_trigger where not tgisinternal and tgname in (
        'nodes_zz_bridge_before', 'nodes_zz_bridge_ins', 'nodes_zz_bridge_upd',
        'nodes_zz_bridge_upd_stmt', 'apps_zz_bridge', 'apps_zz_bridge_ins',
        'tool_groups_zz_bridge', 'users_zz_bridge', 'nodes_inherit_before',
        'nodes_share_refresh_after', 'nodes_share_deleted_after', 'nodes_embed_reach_after',
        'node_embeds_added_after', 'node_embeds_removed_after')`;
    expect(trg).toEqual([]);
  });

  it('(g) the reach diff gains nothing after the switch', async () => {
    expect(await reachFails()).toEqual([]);
  });

  it('(h) archive_node_levels holds the levels as they were at the switch', async () => {
    const [n] = await sql<{ nodes: number; arch: number }[]>`
      select (select count(*)::int from nodes) as nodes,
             (select count(*)::int from archive_node_levels) as arch`;
    expect(n!.arch).toBe(n!.nodes);
    const lv = async (id: string) =>
      (
        await sql<{ a: string; s: string | null; i: string | null; e: string | null }[]>`
          select audience as a, share_level as s, inherited_level as i, embedded_level as e
            from archive_node_levels where node_id = ${id}`
      )[0];
    expect(await lv(ids.teamPage!)).toEqual({ a: 'team', s: null, i: null, e: null });
    expect(await lv(ids.folderShared!)).toMatchObject({ a: 'admin', s: 'team' });
    expect(await lv(ids.inShared!)).toMatchObject({ i: 'team' });
    expect(await lv(ids.embedded!)).toMatchObject({ e: 'team' });
    expect(await lv(ids.publicApp!)).toMatchObject({ a: 'public' });
  });

  it('(b) a level UPDATE is refused, and passes under a named bypass', async () => {
    for (const q of [
      sql`update nodes set audience = 'team' where id = ${ids.adminPage!}`,
      sql`update nodes set share_level = null where id = ${ids.folderShared!}`,
      sql`update nodes set inherited_level = null where id = ${ids.inShared!}`,
      sql`update nodes set embedded_level = null where id = ${ids.embedded!}`,
    ]) {
      await expect(q).rejects.toMatchObject({ code: '55000' });
    }
    // Any other column still changes; an unchanged level is no change.
    await sql`update nodes set title = 'renamed', audience = audience where id = ${ids.adminPage!}`;
    // A hand-set bypass counts for nothing.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('mantle.heads_bypass', 'x|forged', true)`;
        await tx`update nodes set audience = 'team' where id = ${ids.adminPage!}`;
      }),
    ).rejects.toMatchObject({ code: '55000' });
    await sql.begin(async (tx) => {
      await tx`select mantle_heads_bypass('test fixture')`;
      await tx`update nodes set audience = 'team' where id = ${ids.adminPage!}`;
    });
    // The level changed and nothing followed it: no bridge.
    expect(Object.keys(await grants(ids.adminPage!))).toEqual(['Admin']);
    await sql.begin(async (tx) => {
      await tx`select mantle_heads_bypass('test fixture')`;
      await tx`update nodes set audience = 'admin' where id = ${ids.adminPage!}`;
    });
    // An insert may still carry a level; it means nothing.
    const t = await node('newTeamPage', 'page', 'pages', 'team');
    expect(await grants(t)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
  });

  it('(c) a new item gets a home, and its folder rows', async () => {
    const root = await node('root', 'page', 'pages');
    expect(await grants(root)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
    // In the shared folder: home Admin (the folder's), Team from the folder.
    const inS = await node('newInShared', 'page', 'pages.shared');
    expect(await grants(inS)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
      Team: { home: false, excluded: false, write: false, via: ids.folderShared },
    });
    // A folder homed in Team, granted to Admin with Write on.
    const tf = await node('teamFolder', 'branch', 'pages.tf');
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${tf}::uuid], 'update')`;
      await tx`delete from item_grants where node_id = ${tf}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write) values
        (${tf}, ${team}, true, false), (${tf}, ${admin}, false, true)`;
    });
    const inTf = await node('inTeamFolder', 'page', 'pages.tf');
    expect(await grants(inTf)).toEqual({
      Team: { home: true, excluded: false, write: false, via: null },
      Admin: { home: false, excluded: false, write: true, via: tf },
    });
    expect(await derived(inTf)).toEqual({ r: [admin, team].sort(), w: [admin], h: team });
    // An Admin-only kind lives in Admin, in any folder; Team cannot hold it.
    const contact = await node('contactInTf', 'contact', 'pages.tf');
    expect(await grants(contact)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
    expect(await derived(contact)).toEqual({ r: [admin], w: [], h: admin });
  });

  it('(d) an item re-owned into the brain gets the default home', async () => {
    const atRoot = await node('reownRoot', 'page', 'pages', 'admin', spaceA);
    const inTf = await node('reownTf', 'page', 'pages.tf', 'admin', spaceA);
    expect(await grants(atRoot)).toEqual({});
    await sql`update nodes set owner_id = ${owner} where id in (${atRoot}, ${inTf})`;
    expect(await grants(atRoot)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
    expect(await grants(inTf)).toEqual({
      Team: { home: true, excluded: false, write: false, via: null },
      Admin: { home: false, excluded: false, write: true, via: ids.teamFolder },
    });
    expect((await derived(inTf)).h).toBe(team);
  });

  it('(e) the drift repair has nothing left to do', async () => {
    const snap = async () =>
      sql`select node_id::text, workspace_id::text, write, is_home, excluded,
                 via_folder_id::text as via
            from item_grants order by 1, 2`;
    const before = await snap();
    expect(Number((await sql`select mantle_ws_repair_drift() as n`)[0]!.n)).toBe(0);
    expect(await snap()).toEqual(before);
  });

  it('(f) a fresh install migrated later ends with plain rows', async () => {
    const fresh = await createMigratedScratchDatabase(URL!);
    const f = postgres(fresh.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const o = randomUUID();
      await f`insert into auth.users (id, email, password_hash, role, is_owner)
        values (${o}, 'f@example.invalid', 'x', 'admin', true)`;
      const at = async (type: string, path: string, levels: string[]) => {
        const id = randomUUID();
        await f`insert into nodes (id, owner_id, type, title, path, audience, share_level, inherited_level)
          values (${id}, ${o}, ${type}::node_type, ${type}, ${path}::ltree,
                  ${levels[0] ?? 'admin'}, ${levels[1] ?? null}, ${levels[2] ?? null})`;
        return id;
      };
      // Levels written as a brain made before the switch holds them (the
      // upkeep triggers are gone, so the insert names them).
      await at('page', 'pages', ['team']);
      await at('page', 'pages', []);
      const folder = await at('branch', 'pages.shared', ['admin', 'team']);
      const inFolder = await at('page', 'pages.shared', ['admin', null as never, 'team']);
      await at('app', 'apps', ['public']);
      const rows = await f<{ section: string; subject: string }[]>`
        select * from mantle_ws_migrate_locked()`;
      expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
      expect(rows.some((r) => r.section === 'bridge off')).toBe(true);
      expect(Number((await f`select count(*) as n from item_grants where bridge`)[0]!.n)).toBe(0);
      const [d] = await f<{ via: string | null }[]>`
        select g.via_folder_id::text as via from item_grants g
          join workspaces w on w.id = g.workspace_id and w.bridge_key = 'team'
         where g.node_id = ${inFolder}`;
      expect(d!.via).toBe(folder);
      const c = parseWorkspacesCheck((await f.unsafe(WORKSPACES_CHECK_SQL))[0] as never);
      expect(c).toMatchObject({
        migrated: true,
        grantDrift: 0,
        orphanGrants: 0,
        itemsWithoutHome: 0,
        workspacesWithoutModerator: 0,
      });
      expect(await reachFails(f)).toEqual([]);
      // Run again: already migrated, nothing written.
      expect((await f`select * from mantle_ws_migrate_locked()`)[0]).toMatchObject({
        section: 'skip',
        metric: 'already migrated',
      });
    } finally {
      await f.end();
      await fresh.drop();
    }
  }, 180_000);
});
