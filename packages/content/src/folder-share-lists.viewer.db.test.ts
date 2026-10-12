/**
 * Folder-held items in the member Library and at the client level (folder
 * plan phase 4; workspaces W5b2: a folder's grant, not its share level): an
 * item in a folder a workspace holds is listed and opened for that
 * workspace's users, through the folder's grant. (The client portal's own
 * lists went in workspaces W5c, the client login in W8a, the client reader
 * in W8d.) Reads run inside withViewer with a real login, in the
 * shim's workspace scope: a member who is a user of Team, and a second
 * member who is a user of a Clients workspace only, read at the client
 * level.
 *
 * The levels are frozen: the fixture writes them when it inserts a row, as
 * the migration left them next to the grants (an item in a folder clients
 * read carries the client share), because the client portal and the Library
 * badge still name the level (W5c). The grants decide who reads.
 *
 * A scratch database of its own, migrated to workspaces (Team is the
 * brain's own).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/folder-share-lists.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('folder-shared items in the Library and at the client level', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let library: typeof import('./member-library');
  let memberApps: typeof import('./member-apps');
  let chat: typeof import('./chat-images');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | null = null;
  const brain = randomUUID();
  const member = randomUUID();
  /** A member whose only workspace is `clients`, read at the client level. */
  const clientsMember = randomUUID();
  let team = '';
  const clients = randomUUID();
  const label = `fsl${randomUUID().slice(0, 8)}`;
  const teamPath = `notes.${label}_team`;
  const clientPath = `notes.${label}_client`;
  const plainPath = `notes.${label}_plain`;
  const appsTeamPath = `apps.${label}_team`;
  const appsClientPath = `apps.${label}_client`;
  const filesClientPath = `files.${label}_client`;
  const ids = {
    teamF: randomUUID(),
    clientF: randomUUID(),
    plainF: randomUUID(),
    /** Admin by its own level, in the team-shared folder. */
    adminInTeam: randomUUID(),
    /** Public by its own level (an open link), in the team-shared folder. */
    publicInTeam: randomUUID(),
    /** Admin by its own level, in the client-shared folder. */
    adminInClient: randomUUID(),
    /** Team by its own level, in the client-shared folder. */
    teamInClient: randomUUID(),
    /** Admin, in a folder nobody shared. */
    adminPlain: randomUUID(),
    appsTeamF: randomUUID(),
    appsClientF: randomUUID(),
    filesClientF: randomUUID(),
    /** An admin app (green published build) in a folder shared with the team. */
    appInTeam: randomUUID(),
    /** An admin app in a folder shared with clients. */
    appInClient: randomUUID(),
    /** An admin file in a folder shared with clients, and one outside it. */
    fileInClient: randomUUID(),
    filePlain: randomUUID(),
  };
  const title = (id: string) => `${label} ${Object.entries(ids).find(([, v]) => v === id)![0]}`;

  /** A row, with the share level its folder left it (frozen since W5b2). */
  const insert = async (
    id: string,
    type: string,
    path: string,
    audience = 'admin',
    inherited: string | null = null,
  ) => {
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, inherited_level, data, tags)
      values (${id}, ${brain}, ${type}::node_type, ${title(id)}, ${path}::ltree, ${audience},
              ${inherited}, ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb,
              '{}')`);
  };
  /** `ws` holds `id` (a folder passes it to what it holds), or no longer. */
  const hold = (ws: string, id: string, on = true) =>
    m.withSubtreeHeads(id, [], (tx) =>
      tx.execute(
        on
          ? sqlTag`insert into item_grants (node_id, workspace_id, write)
                   values (${id}, ${ws}, true) on conflict do nothing`
          : sqlTag`delete from item_grants where node_id = ${id} and workspace_id = ${ws}`,
      ),
    );
  const loginOf = { team: member, client: clientsMember } as const;
  const as = <T>(reader: 'team' | 'client', fn: () => Promise<T>) =>
    m.withViewer({ login: loginOf[reader] }, fn);

  const listed = async (reader: 'team' | 'client') =>
    as(reader, async () => {
      const res = await library.listLibrary(brain, { q: label, limit: 200 });
      return new Map(res.items.map((r) => [r.id, r]));
    });
  const opens = (reader: 'team' | 'client', id: string) =>
    as(reader, async () => (await library.getLibraryItem(brain, id)) !== null);

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    library = await import('./member-library');
    memberApps = await import('./member-apps');
    chat = await import('./chat-images');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, is_owner, role)
      values (${brain}, ${`${label}-owner@example.invalid`}, 'x', true, 'admin')`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
      on conflict (id) do nothing`);
    await m.systemDb.execute(sqlTag`select * from mantle_ws_migrate()`);
    team = (
      (await m.systemDb.execute(sqlTag`
        select id::text as id from workspaces
         where owner_id = ${brain} and bridge_key = 'team'`)) as unknown as { id: string }[]
    )[0]!.id;
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values (${clients}, ${brain}, 'Clients')`);
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${member}, ${`${label}-m@example.invalid`}, 'x', 'member'),
        (${clientsMember}, ${`${label}-c@example.invalid`}, 'x', 'member')`);
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id) values
        (${team}, ${member}), (${clients}, ${clientsMember})`);
    await tree.ensureKindRoot(brain, 'notes');
    await tree.ensureKindRoot(brain, 'apps');
    await tree.ensureKindRoot(brain, 'files');
    // Team holds the team folders; Team and Clients hold the client ones
    // (a share with clients was read by the team too); nobody the plain one.
    await insert(ids.teamF, 'branch', teamPath);
    await insert(ids.clientF, 'branch', clientPath);
    await insert(ids.plainF, 'branch', plainPath);
    await insert(ids.appsTeamF, 'branch', appsTeamPath);
    await insert(ids.appsClientF, 'branch', appsClientPath);
    await insert(ids.filesClientF, 'branch', filesClientPath);
    for (const f of [ids.teamF, ids.clientF, ids.appsTeamF, ids.appsClientF, ids.filesClientF]) {
      await hold(team, f);
    }
    for (const f of [ids.clientF, ids.appsClientF, ids.filesClientF]) await hold(clients, f);
    await insert(ids.adminInTeam, 'note', teamPath, 'admin', 'team');
    await insert(ids.publicInTeam, 'note', teamPath, 'public', 'team');
    await insert(ids.adminInClient, 'note', clientPath, 'admin', 'client');
    await insert(ids.teamInClient, 'note', clientPath, 'team', 'client');
    await insert(ids.adminPlain, 'note', plainPath);
    await insert(ids.appInTeam, 'app', appsTeamPath, 'admin', 'team');
    await insert(ids.appInClient, 'app', appsClientPath, 'admin', 'client');
    await insert(ids.fileInClient, 'file', filesClientPath, 'admin', 'client');
    await insert(ids.filePlain, 'file', plainPath);
    // A team-level item has Team's grant of its own, not only its folder's.
    await m.withSubtreeHeads(ids.teamInClient, [], (tx) =>
      tx.execute(sqlTag`update item_grants set via_folder_id = null
                         where node_id = ${ids.teamInClient} and workspace_id = ${team}`),
    );
    const green = JSON.stringify({
      storageKey: 'apps/x.js',
      sha256: 'x',
      builtAt: '2026-09-30T00:00:00Z',
      esbuildVersion: '0',
      bytes: 1,
      ok: true,
    });
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build) values
        (${ids.appInTeam}, '{}'::jsonb, ${green}::jsonb),
        (${ids.appInClient}, '{}'::jsonb, ${green}::jsonb)`);
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 60_000);

  it('holds the items in the folders it says', async () => {
    const rows = (await m.systemDb.execute(sqlTag`
      select id::text as id, ${team}::uuid = any(read_ws) as team,
             ${clients}::uuid = any(read_ws) as clients
        from nodes where owner_id = ${brain} and type <> 'branch'`)) as unknown as Array<{
      id: string;
      team: boolean;
      clients: boolean;
    }>;
    const by = new Map(rows.map((r) => [r.id, [r.team, r.clients]]));
    expect(by.get(ids.adminInTeam)).toEqual([true, false]);
    expect(by.get(ids.adminInClient)).toEqual([true, true]);
    expect(by.get(ids.adminPlain)).toEqual([false, false]);
    expect(by.get(ids.fileInClient)).toEqual([true, true]);
  });

  it('lists folder-held items in a member’s Library, with no level badge (W5c)', async () => {
    const got = await listed('team');
    for (const id of [ids.adminInTeam, ids.publicInTeam, ids.adminInClient, ids.teamInClient]) {
      expect(got.has(id), id).toBe(true);
      expect('audience' in got.get(id)!, id).toBe(false);
    }
    expect(got.has(ids.adminPlain)).toBe(false);
  });

  it('opens them for a member, never an unshared admin item', async () => {
    expect(await opens('team', ids.adminInTeam)).toBe(true);
    expect(await opens('team', ids.adminInClient)).toBe(true);
    expect(await opens('team', ids.adminPlain)).toBe(false);
  });

  it('opens at the client level only what a folder its workspace holds holds', async () => {
    expect(await opens('client', ids.adminInClient)).toBe(true);
    expect(await opens('client', ids.teamInClient)).toBe(true);
    expect(await opens('client', ids.adminInTeam)).toBe(false);
    expect(await opens('client', ids.publicInTeam)).toBe(false);
  });

  it('drops them again when the workspaces no longer hold the folder', async () => {
    await hold(clients, ids.clientF, false);
    await hold(team, ids.clientF, false);
    try {
      const got = await listed('team');
      expect(got.has(ids.adminInClient)).toBe(false);
      // Its own grant keeps it for the team.
      expect(got.has(ids.teamInClient)).toBe(true);
      expect(await opens('client', ids.teamInClient)).toBe(false);
      expect(await opens('client', ids.adminInClient)).toBe(false);
    } finally {
      await hold(team, ids.clientF);
      await hold(clients, ids.clientF);
    }
    expect(await opens('client', ids.adminInClient)).toBe(true);
  });

  it('runs an admin app in a held folder for the workspaces that hold it', async () => {
    const teamApps = await as('team', () => memberApps.listMemberApps(brain));
    const inTeam = teamApps.find((a) => a.id === ids.appInTeam);
    // Team holds it through its folder, Write on: a member runs it and
    // writes its data.
    expect(inTeam).toMatchObject({ dataReadOnly: false });
    // The launcher card carries no level since W5c.
    expect(inTeam && 'audience' in inTeam).toBe(false);
    expect(teamApps.find((a) => a.id === ids.appInClient)).toBeDefined();
    const run = await as('team', () => memberApps.getMemberRunnableApp(brain, ids.appInTeam));
    expect(run?.writable).toBe(true);
    // The team surfaces' app-data reach (admin pool).
    const teamIds = await memberApps.listTeamLevelAppIds(brain);
    expect(teamIds.has(ids.appInTeam) && teamIds.has(ids.appInClient)).toBe(true);
  });

  it('shows a member a chat image from a folder its workspace holds, not one outside', async () => {
    const got = await chat.chatImagesFor(brain, 'team', member, [ids.fileInClient, ids.filePlain]);
    expect([...got.keys()]).toEqual([ids.fileInClient.toLowerCase()]);
  });
});
