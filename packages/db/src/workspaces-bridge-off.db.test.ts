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
 *      a top folder shared by its share level alone holds a Team row of its
 *      own (Write off) and passes Team on, its items derived from it;
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
  const sales = randomUUID();

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
    // A top folder shared by its share level (the folder itself is not
    // read by the team: a folder inherits only from folders above it).
    await node('folderShared', 'branch', 'pages.shared');
    await sql`update nodes set share_level = 'team' where id = ${ids.folderShared!}`;
    await node('inShared', 'page', 'pages.shared'); // team through the share
    await node('teamInShared', 'page', 'pages.shared', 'team');
    // A sub-folder of it (team through the share) and its items.
    await node('subShared', 'branch', 'pages.shared.sub');
    await node('inSub', 'page', 'pages.shared.sub');
    await node('removedKept', 'page', 'pages.shared.sub');
    // A folder the team reads by its own level, and shares.
    await node('folderBoth', 'branch', 'pages.both', 'team');
    await sql`update nodes set share_level = 'team' where id = ${ids.folderBoth!}`;
    await node('inBoth', 'page', 'pages.both');
    await node('embedded', 'file', 'files');
    await sql`insert into node_embeds (from_id, to_id) values (${ids.inShared!}, ${ids.embedded!})`;
    await node('teamApp', 'app', 'apps', 'team');
    await node('publicApp', 'app', 'apps', 'public');
    // An informational team app (data_read_only): members only read it.
    await node('infoApp', 'app', 'apps', 'team');
    await sql`insert into apps (node_id, source, data_read_only) values
      (${ids.teamApp!}, '{}'::jsonb, false), (${ids.publicApp!}, '{}'::jsonb, false),
      (${ids.infoApp!}, '{}'::jsonb, true)`;
    await node('draft', 'page', 'pages', 'admin', spaceA);
    const [lv] = await sql<{ i: string | null; s: string | null; e: string | null }[]>`
      select (select inherited_level from nodes where id = ${ids.inShared!}) as i,
             (select inherited_level from nodes where id = ${ids.subShared!}) as s,
             (select embedded_level from nodes where id = ${ids.embedded!}) as e`;
    expect(lv).toEqual({ i: 'team', s: 'team', e: 'team' });

    // Migrated through the bridge, as 0252 did on a live box.
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const ws = await sql<{ id: string; key: string }[]>`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces`;
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
      // M1: a sub-folder's Team row with Write on, its item's row off. Step
      // b derives the item's row from the folder: Write may only narrow
      // (before the fix it took the folder's Write and widened).
      await tx`update item_grants set write = true
                where node_id = ${ids.subShared!} and workspace_id = ${team}`;
      await tx`update item_grants set write = false
                where node_id = ${ids.inSub!} and workspace_id = ${team}`;
      // An informational app granted by hand, Write on, to another
      // workspace (data_read_only keeps its users from writing).
      await tx`insert into workspaces (id, owner_id, name) values (${sales}, ${owner}, 'Sales')`;
      await tx`insert into item_grants (node_id, workspace_id, write)
                values (${ids.infoApp!}, ${sales}, true)`;
    });
    expect(await bridgeRows()).toBeGreaterThan(0);
    expect((await grants(ids.folderOwn!)).Team).toMatchObject({ excluded: false });
    expect((await grants(ids.inOwn!)).Team).toMatchObject({ excluded: true });
    expect((await grants(ids.adminPage!)).Team).toMatchObject({ excluded: true });
    // The bridge decided the top shared folder "removed here" for Team.
    expect((await grants(ids.folderShared!)).Team).toMatchObject({ excluded: true });

    await scratch.migrateRest('0267_workspaces_spaces_fold'); // W6b folds the spaces
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
    // A Team row a folder's share gave is derived from that folder, where
    // the folder holds Team itself (a sub-folder of a shared folder, or a
    // folder the team reads).
    for (const [item, folder] of [
      ['inSub', 'subShared'],
      ['inBoth', 'folderBoth'],
    ] as const) {
      expect((await grants(ids[item]!)).Team).toEqual({
        home: false,
        excluded: false,
        write: false,
        via: ids[folder],
      });
    }
    // The folder that reads Team by its own level keeps a plain row; the
    // sub-folder of the top shared folder derives Team from it (step a0).
    expect((await grants(ids.folderBoth!)).Team).toMatchObject({ excluded: false, via: null });
    expect((await grants(ids.subShared!)).Team).toMatchObject({
      excluded: false,
      via: ids.folderShared,
    });
    // An item's own level and an embed keep plain rows; an item of the top
    // shared folder derives Team from it (step a0): nobody loses a read.
    expect((await grants(ids.teamInShared!)).Team).toMatchObject({ excluded: false, via: null });
    expect((await grants(ids.embedded!)).Team).toMatchObject({ excluded: false, via: null });
    expect((await grants(ids.inShared!)).Team).toMatchObject({
      excluded: false,
      via: ids.folderShared,
    });
    // "Removed here" with no folder grant: gone; against one: kept.
    expect(Object.keys(await grants(ids.adminPage!))).toEqual(['Admin']);
    expect((await grants(ids.removedKept!)).Team).toMatchObject({ excluded: true });
    expect((await derived(ids.removedKept!)).r).toEqual([admin]);
    // A public app's Team row: Write off. A team app keeps its Write.
    expect(await grants(ids.publicApp!)).toEqual({
      Team: { home: true, excluded: false, write: false, via: null },
    });
    expect((await grants(ids.teamApp!)).Team).toMatchObject({ home: true, write: true });
    // An informational app keeps its rows: the bridge gave Team no Write
    // (data_read_only), and a hand row with Write on stays as it is. The
    // member write rule reads the flag as an AND (contract change 36).
    const info = await grants(ids.infoApp!);
    expect(info.Team).toMatchObject({ write: false });
    expect(info.Sales).toMatchObject({ write: true, excluded: false });
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

  // The bridge decided a top folder shared by its share level alone
  // "removed here" for Team (the folder itself was never read by the team).
  // 0261 step a0 gives such a folder a Team row of its own (Write off), so
  // its items derive Team from it and an item placed in it later is shared
  // with the team as before the switch. The accepted widening: members read
  // the folder node (its title); the reach diff counts it as read today.
  it('a top folder shared by its share level keeps passing Team on', async () => {
    expect((await grants(ids.folderShared!)).Team).toMatchObject({
      excluded: false,
      write: false,
      via: null,
    });
    expect((await grants(ids.inShared!)).Team).toMatchObject({ via: ids.folderShared });
  });

  it('(g) the reach diff gains nothing after the switch', async () => {
    expect(await reachFails()).toEqual([]);
    // The whole proof (reads, chunks, facts, writes) passes too.
    const rows = await sql<{ section: string }[]>`select * from mantle_ws_switch_guard()`;
    expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
  });

  // M1 and M2: the guard raises 23514 on any gained read, write or fact,
  // so the migration (or mantle_ws_migrate) rolls back. Each case in
  // a transaction rolled back after.
  it("(i) the switch guard refuses a gained read, write or fact (links are 0262's)", async () => {
    const refused = async (what: RegExp, fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
      const err = await sql
        .begin(async (tx) => {
          await tx`select set_config('mantle.acl_internal', 'on', true)`;
          await fn(tx);
          await tx`select * from mantle_ws_switch_guard()`;
        })
        .then(
          () => null,
          (e: { code?: string; message?: string }) => e,
        );
      expect(err).toMatchObject({ code: '23514' });
      expect(err!.message).toMatch(what);
    };
    // A read: Team on an Admin-only page.
    await refused(
      /gained items/,
      (tx) =>
        tx`insert into item_grants (node_id, workspace_id) values (${ids.adminPage!}, ${team})`,
    );
    // A fact read by Team with no source item (a chat fact is Admin's).
    await refused(/facts/, async (tx) => {
      const [f] = await tx<{ id: string }[]>`insert into facts (owner_id, kind, content)
        values (${owner}, 'factual', 'h2 fact') returning id`;
      await tx`update facts set read_ws = ARRAY[${team}::uuid] where id = ${f!.id}`;
    });
    // A write the switch gave: before = now, then Write turned on.
    await refused(/writes/, async (tx) => {
      await tx`create temp table ws_switch_writes_before (node_id uuid, workspace_id uuid)
                 on commit drop`;
      await tx`insert into ws_switch_writes_before
               select n.id, x from nodes n cross join lateral unnest(n.write_ws) x`;
      await tx`update item_grants set write = true
                where node_id = ${ids.teamPage!} and workspace_id = ${team}`;
    });
    // A serve is not the guard's (L3): 0262 checks the links once, right
    // after it fills them. An open link on the public note that serves the
    // Admin page passes the guard; the links diff (0262's check) sees it.
    await sql
      .begin(async (tx) => {
        await tx`insert into shares (owner_id, node_id, node_type, token, settings)
          values (${owner}, ${ids.publicNote!}, 'note', ${`t-${randomUUID()}`},
                  ${sql.json({ served: [ids.adminPage!] })})`;
        const proof = await tx<{ section: string; subject: string }[]>`
          select * from mantle_ws_switch_guard()`;
        expect(proof.some((r) => r.subject === 'links')).toBe(false);
        const links = await tx<{ section: string }[]>`select * from mantle_ws_links_diff()`;
        expect(links.filter((r) => r.section === 'reach-fail')).toHaveLength(1);
        throw new Error('rollback');
      })
      .catch((e: Error) => {
        if (e.message !== 'rollback') throw e;
      });
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

  it('an item placed in the shared folder after the switch reaches Team', async () => {
    const later = await node('laterInShared', 'page', 'pages.shared');
    expect((await grants(later)).Team).toMatchObject({
      excluded: false,
      write: false,
      via: ids.folderShared,
    });
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
    // A folder homed in Team, granted to Admin with Write on (made first:
    // (d) uses it too).
    const tf = await node('teamFolder', 'branch', 'pages.tf');
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${tf}::uuid], 'update')`;
      await tx`delete from item_grants where node_id = ${tf}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write) values
        (${tf}, ${team}, true, false), (${tf}, ${admin}, false, true)`;
    });
    const root = await node('root', 'page', 'pages');
    expect(await grants(root)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
    });
    // In a folder that grants Team: home Admin (the folder's), Team from the
    // folder.
    const inB = await node('newInBoth', 'page', 'pages.both');
    expect(await grants(inB)).toEqual({
      Admin: { home: true, excluded: false, write: false, via: null },
      Team: { home: false, excluded: false, write: false, via: ids.folderBoth },
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
      // A folder the team reads and shares (one shared by its share level
      // alone passes nothing on: see the it.fails above).
      const folder = await at('branch', 'pages.shared', ['team', 'team']);
      const inFolder = await at('page', 'pages.shared', ['admin', null as never, 'team']);
      await at('app', 'apps', ['public']);
      const rows = await f<{ section: string; subject: string }[]>`
        select * from mantle_ws_migrate_locked()`;
      expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
      expect(rows.some((r) => r.section === 'bridge off')).toBe(true);
      expect(Number((await f`select count(*) as n from item_grants where bridge`)[0]!.n)).toBe(0);
      const [d] = await f<{ via: string | null }[]>`
        select g.via_folder_id::text as via from item_grants g
          join workspaces w on w.id = g.workspace_id and w.name = 'Team' and not w.is_admin
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

// H2 (owner rule 21.9): a brain that was never moved to workspaces (here:
// it has a client login) is not switched by 0261. It keeps its levels, its
// bridge and its level upkeep; nothing is archived; mantle_ws_migrate_locked
// still skips it until it is set up by hand. Its members no longer read on
// the team level role (retired in W8c: the grants are revoked after every
// migrate).
describe.skipIf(!URL)('0261 leaves a brain that is not on workspaces alone (H2)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const ids: Record<string, string> = {};
  const node = async (key: string, type: string, path: string, audience = 'admin') => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${owner}, ${type}::node_type, ${key}, ${path}::ltree, ${audience})`;
    ids[key] = id;
    return id;
  };
  /** The brain titles the team level role reads (a member's reads before
   *  W8c). */
  const teamReads = async () =>
    (
      await sql.begin(async (tx) => {
        await tx`set local role mantle_view_team`;
        return tx<{ title: string }[]>`select title from nodes
          where owner_id = ${owner} and type <> 'branch' order by title`;
      })
    ).map((r) => r.title);

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0261_workspaces_bridge_off');
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'h2o@example.invalid', 'x', 'admin', true),
      (${member}, 'h2m@example.invalid', 'x', 'member', false),
      (${client}, 'h2c@example.invalid', 'x', 'client', false)`;
    await node('adminPage', 'page', 'pages');
    await node('teamPage', 'page', 'pages', 'team');
    await node('folderShared', 'branch', 'pages.shared');
    await sql`update nodes set share_level = 'team' where id = ${ids.folderShared!}`;
    await node('inShared', 'page', 'pages.shared');
    // The 0251 pass skips this brain: clients are set up by hand.
    const [w] = await sql<{ why: string | null }[]>`select mantle_ws_skip_reason() as why`;
    expect(w!.why).toMatch(/^clients present/);
    await scratch.migrateRest('0267_workspaces_spaces_fold'); // W6b folds the spaces
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('keeps the bridge and the level upkeep triggers, and no freeze', async () => {
    const rows = await sql<{ t: string }[]>`select tgname as t from pg_trigger
      where tgname in ('nodes_zz_bridge_ins', 'nodes_zz_bridge_upd', 'users_zz_bridge',
                       'nodes_inherit_before', 'nodes_share_refresh_after',
                       'node_embeds_added_after', 'nodes_levels_frozen')`;
    expect(rows.map((r) => r.t).sort()).toEqual([
      'node_embeds_added_after',
      'nodes_inherit_before',
      'nodes_share_refresh_after',
      'nodes_zz_bridge_ins',
      'nodes_zz_bridge_upd',
      'users_zz_bridge',
    ]);
    expect(Number((await sql`select count(*) as n from archive_node_levels`)[0]!.n)).toBe(0);
    expect((await sql`select * from mantle_ws_migrate_locked()`)[0]).toMatchObject({
      section: 'skip',
    });
  });

  it('the levels still change and keep their upkeep; the team level role reads nothing (W8c)', async () => {
    await expect(teamReads()).rejects.toMatchObject({ code: '42501' });
    await sql`update nodes set audience = 'team' where id = ${ids.adminPage!}`;
    await node('laterInShared', 'page', 'pages.shared');
    const [lv] = await sql<{ i: string | null }[]>`
      select inherited_level as i from nodes where id = ${ids.laterInShared!}`;
    expect(lv!.i).toBe('team');
  });

  // L3: the links were checked once, by 0262. A tick the owner makes on a
  // link afterwards (here: an Admin page served) must not block the hand
  // setup of this box: the later switch checks reads, facts and writes.
  it('the hand setup later switches it, whatever a link serves since 0262 (L3)', async () => {
    const secret = await node('secret', 'page', 'pages');
    await sql`insert into shares (owner_id, node_id, node_type, token, settings)
      values (${owner}, ${ids.teamPage!}, 'page', ${`t-${randomUUID()}`},
              ${sql.json({ served: [secret] })})`;
    const links = await sql<{ section: string }[]>`select * from mantle_ws_links_diff()`;
    expect(links.filter((r) => r.section === 'reach-fail')).toHaveLength(1);
    // Set up by hand (21.9): here, the one client login is removed.
    await sql`delete from auth.users where id = ${client}`;
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe('no workspaces yet');
    const rows = await sql<{ section: string; subject: string }[]>`
      select * from mantle_ws_migrate_locked()`;
    expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
    expect(rows.some((r) => r.section === 'bridge off')).toBe(true);
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    const trg = await sql`select 1 from pg_trigger where tgname = 'nodes_levels_frozen'`;
    expect(trg).toHaveLength(1);
  });
});

// L4: the switch at boot (mantle_ws_migrate_locked) runs under a time
// budget. A brain that has an owner but no workspaces when 0261 runs is
// switched later, at boot; while a writer holds a table whose trigger the
// switch drops, the DDL tries end at the budget with 55P03 and the whole
// transaction rolls back: no workspaces, no frozen levels, the bridge
// triggers in place, the skip reason (the integrity row) unchanged. Once
// the table is free, the next try switches it.
describe.skipIf(!URL)('the boot switch gives up at its time budget (L4)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  let holder: ReturnType<typeof postgres>;
  const owner = randomUUID();

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0261_workspaces_bridge_off');
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    holder = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, 'l4o@example.invalid', 'x', 'admin', true)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${randomUUID()}, ${owner}, 'page', 'l4 page', 'pages', 'team')`;
    await scratch.migrateRest('0267_workspaces_spaces_fold'); // W6b folds the spaces
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe('no workspaces yet');
  }, 240_000);

  afterAll(async () => {
    await holder?.end();
    await sql?.end();
    await scratch?.drop();
  });

  const state = async () => {
    const [r] = await sql<
      { ws: number; frozen: number; bridge: number; arch: number; why: string | null }[]
    >`
      select (select count(*)::int from workspaces) as ws,
             (select count(*)::int from pg_trigger where tgname = 'nodes_levels_frozen') as frozen,
             (select count(*)::int from pg_trigger where tgname = 'tool_groups_zz_bridge') as bridge,
             (select count(*)::int from archive_node_levels) as arch,
             mantle_ws_skip_reason() as why`;
    return r!;
  };

  it('times out with 55P03 and changes nothing, then switches once the table is free', async () => {
    expect(await state()).toEqual({
      ws: 0,
      frozen: 0,
      bridge: 1,
      arch: 0,
      why: 'no workspaces yet',
    });
    const reserved = await holder.reserve();
    await reserved`begin`;
    await reserved`lock table tool_groups in row exclusive mode`;
    const t0 = Date.now();
    const err = await sql
      .begin(async (tx) => {
        await tx`select set_config('mantle.ws_switch_budget', '3 seconds', true)`;
        return tx`select * from mantle_ws_migrate_locked()`;
      })
      .then(
        () => null,
        (e: { code?: string; message?: string }) => e,
      );
    const took = Date.now() - t0;
    await reserved`rollback`;
    reserved.release();
    expect(err).toMatchObject({ code: '55P03' });
    expect(err!.message).toMatch(/time budget/);
    // The budget held (a 12-try loop would have taken minutes).
    expect(took).toBeLessThan(15_000);
    expect(await state()).toEqual({
      ws: 0,
      frozen: 0,
      bridge: 1,
      arch: 0,
      why: 'no workspaces yet',
    });

    const rows = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const after = await state();
    expect(after).toMatchObject({ frozen: 1, bridge: 0, why: null });
    expect(after.ws).toBeGreaterThan(0);
    expect(after.arch).toBeGreaterThan(0);
  }, 60_000);
});
