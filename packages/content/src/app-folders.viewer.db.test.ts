/**
 * The Apps launcher for members, on a real, migrated Postgres
 * (./app-folders.ts, `appLauncher`): the apps are read in the member's
 * workspace scope, and the folders are the brain's rows on the way to those
 * apps and nothing else, as the route answers them (GET /api/member/apps).
 * The client launcher went with the client portal in workspaces W5c.
 *
 *  - a member sees an app inside a folder Team holds (the folder's grant,
 *    workspaces W5b2), with the folder's name, icon and colour;
 *  - a member does not see an admin-only app that sits next to a team app,
 *    nor a draft (no published build) in a shared folder;
 *  - a folder that holds only admin-only apps, or only drafts, is not
 *    answered at all: not its name, not its id, shared or not;
 *  - the folders on the way to an app come with it, each under its parent;
 *  - when Team no longer holds the folder, its apps and the folder go;
 *  - another owner's folder at the same path, and a member's own folder
 *    there, are never answered;
 *  - an app read only through an embed is not run, and names no folder.
 *
 * The brain is the box's brain of a scratch database of its own, migrated to
 * workspaces. The readers are real logins in the shim's workspace scope
 * (withViewer with { login }): a member who is a user of Team runs the apps
 * Team holds (its grants). A second workspace holds the client-level
 * folder and apps, with a second member as its user; no launcher test reads
 * it (there is no client login since W8a). The levels
 * are frozen: the fixture writes them when
 * it inserts a row. Every folder is inserted in one statement with what it
 * holds, so it never sits empty.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-folders.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Apps launcher folders for members', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let folders: typeof import('./app-folders');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | null = null;
  const brain = randomUUID();
  let team = '';
  /** A second workspace, for the client-level folder and apps. */
  const second = randomUUID();
  /** A second member login, a user of `second`. */
  const secondMember = randomUUID();
  const label = `apf${randomUUID().slice(0, 8)}`;
  const path = {
    shared: `apps.${label}_shared`,
    plain: `apps.${label}_plain`,
    hidden: `apps.${label}_hidden`,
    drafts: `apps.${label}_drafts`,
    deep: `apps.${label}_deep`,
    mid: `apps.${label}_deep.${label}_mid`,
    leaf: `apps.${label}_deep.${label}_mid.${label}_leaf`,
    side: `apps.${label}_deep.${label}_side`,
    client: `apps.${label}_client`,
    /** Unshared, above a folder shared with the team. */
    grand: `apps.${label}_grand`,
    parent: `apps.${label}_grand.${label}_parent`,
    /** Unshared: holds only an app that a shared note embeds. */
    embedded: `apps.${label}_embedded`,
    /** A notes folder shared with the team, for the note that embeds. */
    notes: `notes.${label}_notes`,
  };
  const f = {
    shared: randomUUID(),
    plain: randomUUID(),
    hidden: randomUUID(),
    drafts: randomUUID(),
    deep: randomUUID(),
    mid: randomUUID(),
    leaf: randomUUID(),
    side: randomUUID(),
    client: randomUUID(),
    grand: randomUUID(),
    parent: randomUUID(),
    embedded: randomUUID(),
  };
  const a = {
    /** Admin by its own level, published, in the folder shared with the team. */
    adminInShared: randomUUID(),
    /** Admin, never published, in the folder shared with the team. */
    draftInShared: randomUUID(),
    /** Team by its own level, published, in a folder nobody shared. */
    teamInPlain: randomUUID(),
    /** Client by its own level, published, in the same unshared folder. */
    clientInPlain: randomUUID(),
    /** Admin, published, in the same unshared folder. */
    adminInPlain: randomUUID(),
    /** Admin, published: all its folder holds. */
    adminHidden: randomUUID(),
    /** Team, never published: all the shared drafts folder holds. */
    draftOnly: randomUUID(),
    /** Team, published, three folders down. */
    teamDeep: randomUUID(),
    /** Admin, published, in a side folder of the deep one. */
    adminSide: randomUUID(),
    /** Admin, published, in the folder the second workspace holds. */
    adminInClient: randomUUID(),
    /** Team, published, at the top level. */
    teamTop: randomUUID(),
    /** Client, team (admin by its own level) and public, published, in the
     *  team-shared folder under the unshared one. */
    clientInParent: randomUUID(),
    adminInParent: randomUUID(),
    publicInParent: randomUUID(),
    /** Admin, published, read at team only through a shared note's embed. */
    embeddedOnly: randomUUID(),
  };
  /** Rows that are not this brain's: another owner's, and a member's own. */
  const other = randomUUID();
  const member = randomUUID();
  const foreign = {
    otherFolder: randomUUID(),
    otherApp: randomUUID(),
    memberFolder: randomUUID(),
  };
  const notesFolder = randomUUID();
  const embedNote = randomUUID();
  let memberSpace = '';

  const nameOf = (ids: Record<string, string>, id: string) =>
    `${label} ${Object.entries(ids).find(([, v]) => v === id)![0]}`;
  const folderName = (id: string) => `${nameOf(f, id)} folder`;
  const appTitle = (id: string) => `${nameOf(a, id)} app`;
  const foreignName = (id: string) => `${nameOf(foreign, id)} foreign`;

  type NodeRow = {
    id: string;
    owner: string;
    type: string;
    title: string;
    at: string;
    audience?: string;
    /** The archived folder share and embed levels, as the migration left
     *  them (read by the level roles' row security only). */
    inherited?: string;
    embedded?: string;
    data?: Record<string, unknown>;
  };
  /**
   * Rows in ONE statement, so none is ever seen without the others. A folder
   * goes in together with what it holds: this file runs next to others on
   * the shared anchor, and a folder that sat there empty for a moment was
   * once deleted by another file's cleanup of "new, empty folders" in the
   * middle of this setup (three cases failed, 2026-10-01).
   */
  const insertNodes = (rows: NodeRow[]) =>
    m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, inherited_level,
                         embedded_level, data, tags)
      values ${sqlTag.join(
        rows.map(
          (r) => sqlTag`(${r.id}, ${r.owner}, ${r.type}::node_type, ${r.title}, ${r.at}::ltree,
                         ${r.audience ?? 'admin'}, ${r.inherited ?? null}, ${r.embedded ?? null},
                         ${JSON.stringify(r.data ?? {})}::jsonb, '{}')`,
        ),
        sqlTag`, `,
      )}`);
  const folderRow = (id: string, at: string, data: Record<string, unknown> = {}): NodeRow => ({
    id,
    owner: brain,
    type: 'branch',
    title: folderName(id),
    at,
    data,
  });
  const appRow = (
    id: string,
    at: string,
    audience: string,
    levels: { inherited?: string; embedded?: string } = {},
  ): NodeRow => ({
    id,
    owner: brain,
    type: 'app',
    title: appTitle(id),
    at,
    audience,
    ...levels,
  });
  const green = JSON.stringify({
    storageKey: 'apps/x.js',
    sha256: 'x',
    builtAt: '2026-10-01T00:00:00Z',
    esbuildVersion: '0',
    bytes: 1,
    ok: true,
  });
  /** The app rows of `builds`: [node id, has a green published build]. */
  const publish = (builds: Array<[string, boolean]>) =>
    m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build, draft_build)
      values ${sqlTag.join(
        builds.map(
          ([id, published]) =>
            sqlTag`(${id}, '{}'::jsonb, ${published ? green : null}::jsonb, ${green}::jsonb)`,
        ),
        sqlTag`, `,
      )}`);
  /** `ws` holds `id` (a folder passes it to what it holds), or no longer. */
  const hold = (ws: string, id: string, on: boolean) =>
    m.withSubtreeHeads(id, [], (tx) =>
      tx.execute(
        on
          ? sqlTag`insert into item_grants (node_id, workspace_id, write)
                   values (${id}, ${ws}, true) on conflict do nothing`
          : sqlTag`delete from item_grants where node_id = ${id} and workspace_id = ${ws}`,
      ),
    );
  const holdTeam = (id: string, on: boolean) => hold(team, id, on);

  const ourFolders = new Set<string>(Object.values(f));
  const ourApps = new Set<string>(Object.values(a));
  /** What the route answers for a reader, narrowed to this run's rows. */
  const launcher = async (reader: 'team') => {
    const all: {
      apps: Array<{ id: string }>;
      folders: Awaited<ReturnType<typeof folders.appLauncher>>['folders'];
    } = await folders.appLauncher(brain, reader, member);
    return {
      apps: all.apps.filter((x) => ourApps.has(x.id)),
      folders: all.folders
        .filter((x) => ourFolders.has(x.id))
        .map((x) => ({ ...x, appIds: x.appIds.filter((id) => ourApps.has(id)) })),
      /** Everything the reader is answered, as it goes over the wire. */
      wire: JSON.stringify(all),
    };
  };
  const byId = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id);

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    folders = await import('./app-folders');
    sqlTag = (await import('drizzle-orm')).sql;
    // The viewer roles are the cluster's (set up once for the test run): a
    // scratch database never resets them.
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
         where owner_id = ${brain} and name = 'Team' and not is_admin`)) as unknown as {
        id: string;
      }[]
    )[0]!.id;
    await tree.ensureKindRoot(brain, 'apps');
    await tree.ensureKindRoot(brain, 'notes');

    // Every folder with every app, in one statement: no folder of this file
    // is ever in the anchor with nothing in it.
    await insertNodes([
      folderRow(f.shared, path.shared, { icon: 'lucide:rocket', color: 'teal' }),
      folderRow(f.plain, path.plain),
      folderRow(f.hidden, path.hidden),
      folderRow(f.drafts, path.drafts),
      folderRow(f.deep, path.deep),
      folderRow(f.mid, path.mid),
      folderRow(f.leaf, path.leaf),
      folderRow(f.side, path.side),
      folderRow(f.client, path.client),
      folderRow(f.grand, path.grand),
      folderRow(f.parent, path.parent),
      folderRow(f.embedded, path.embedded),
      appRow(a.adminInShared, path.shared, 'admin', { inherited: 'team' }),
      appRow(a.draftInShared, path.shared, 'admin'),
      appRow(a.teamInPlain, path.plain, 'team'),
      appRow(a.clientInPlain, path.plain, 'client'),
      appRow(a.adminInPlain, path.plain, 'admin'),
      appRow(a.adminHidden, path.hidden, 'admin'),
      appRow(a.draftOnly, path.drafts, 'team'),
      appRow(a.teamDeep, path.leaf, 'team'),
      appRow(a.adminSide, path.side, 'admin'),
      appRow(a.adminInClient, path.client, 'admin', { inherited: 'client' }),
      appRow(a.teamTop, 'apps', 'team'),
      appRow(a.clientInParent, path.parent, 'client', { inherited: 'team' }),
      appRow(a.adminInParent, path.parent, 'admin', { inherited: 'team' }),
      appRow(a.publicInParent, path.parent, 'public', { inherited: 'team' }),
      appRow(a.embeddedOnly, path.embedded, 'admin', { embedded: 'team' }),
    ]);
    await publish([
      [a.adminInShared, true],
      [a.draftInShared, false],
      [a.teamInPlain, true],
      [a.clientInPlain, true],
      [a.adminInPlain, true],
      [a.adminHidden, true],
      [a.draftOnly, false],
      [a.teamDeep, true],
      [a.adminSide, true],
      [a.adminInClient, true],
      [a.teamTop, true],
      [a.clientInParent, true],
      [a.adminInParent, true],
      [a.publicInParent, true],
      [a.embeddedOnly, true],
    ]);

    // Team holds these folders (and what they hold) and these apps; the
    // second workspace holds the client folder and the two client apps.
    for (const id of [f.shared, f.drafts, f.parent]) await holdTeam(id, true);
    for (const id of [a.teamInPlain, a.clientInPlain, a.teamDeep, a.teamTop]) {
      await holdTeam(id, true);
    }
    await m.systemDb.execute(sqlTag`
      insert into workspaces (id, owner_id, name) values (${second}, ${brain}, ${`${label} Second`})`);
    for (const id of [f.client, a.clientInPlain, a.clientInParent]) await hold(second, id, true);

    // A note in a notes folder Team holds embeds the app: an embed gives no
    // grant, so the app never runs. The folder and its note in one
    // statement, for the same reason as above.
    await insertNodes([
      {
        id: notesFolder,
        owner: brain,
        type: 'branch',
        title: `${label} notes folder`,
        at: path.notes,
      },
      {
        id: embedNote,
        owner: brain,
        type: 'note',
        title: `${label} embeds an app`,
        at: path.notes,
        data: { content: `![x](media:${a.embeddedOnly})` },
      },
    ]);
    await holdTeam(notesFolder, true);

    // Another brain with a folder and a team app at one of our paths, and a
    // member's own folder there: rows of other owners at the same path.
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${other}, ${`${label}-other@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${label}-pat@example.invalid`}, 'x', 'member', 'Pat Member'),
        (${secondMember}, ${`${label}-second@example.invalid`}, 'x', 'member', 'Second Member')`);
    await m.systemDb.execute(sqlTag`
      insert into workspace_users (workspace_id, login_id) values
        (${team}, ${member}), (${second}, ${secondMember})`);
    await m.systemDb.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${other}, 'brain', ${other})`);
    memberSpace = (
      (await m.systemDb.execute(sqlTag`
        select id from spaces where kind = 'personal' and login_id = ${member}`)) as unknown as {
        id: string;
      }[]
    )[0]!.id;
    await insertNodes([
      {
        id: foreign.otherFolder,
        owner: other,
        type: 'branch',
        title: foreignName(foreign.otherFolder),
        at: path.shared,
      },
      {
        id: foreign.otherApp,
        owner: other,
        type: 'app',
        title: foreignName(foreign.otherApp),
        at: path.shared,
        audience: 'team',
      },
      {
        id: foreign.memberFolder,
        owner: memberSpace,
        type: 'branch',
        title: foreignName(foreign.memberFolder),
        at: path.shared,
      },
    ]);
    await publish([[foreign.otherApp, true]]);
  }, 60_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 60_000);

  it('holds every folder of the fixture, each with something in it (no other file can take it for an empty one)', async () => {
    // What another file's cleanup of empty folders in the shared anchor
    // would delete: a folder with nothing at or below its path. None of
    // ours, at any moment, since each went in with what it holds.
    const ours = [...Object.values(f), notesFolder];
    const rows = (await m.systemDb.execute(sqlTag`
      select b.id::text as id,
             not exists (select 1 from nodes c
                          where c.owner_id = b.owner_id and c.id <> b.id
                            and c.path <@ b.path) as empty
        from nodes b
       where b.owner_id = ${brain} and b.type = 'branch'
         and b.id = any(${`{${ours.join(',')}}`}::uuid[])`)) as unknown as Array<{
      id: string;
      empty: boolean;
    }>;
    expect(rows.map((r) => r.id).sort()).toEqual([...ours].sort());
    expect(rows.filter((r) => r.empty)).toEqual([]);
  });

  it('shows a member an app inside a folder Team holds, with the folder’s look', async () => {
    const got = await launcher('team');
    // Listed, with no level on the card (W5c).
    expect(byId(got.apps, a.adminInShared)).toBeDefined();
    expect(byId(got.apps, a.adminInShared)).not.toHaveProperty('audience');
    expect(byId(got.folders, f.shared)).toEqual({
      id: f.shared,
      name: folderName(f.shared),
      icon: 'lucide:rocket',
      color: 'teal',
      parentId: null,
      appIds: [a.adminInShared],
    });
  });

  it('never shows a member an admin-only app or a draft that sits in the same folder', async () => {
    const got = await launcher('team');
    // The unshared folder: its team and client apps, not the admin one.
    expect(byId(got.folders, f.plain)?.appIds.sort()).toEqual(
      [a.teamInPlain, a.clientInPlain].sort(),
    );
    const listed = new Set(got.apps.map((x) => x.id));
    for (const id of [a.adminInPlain, a.draftInShared, a.adminHidden, a.draftOnly, a.adminSide]) {
      expect(listed.has(id), nameOf(a, id)).toBe(false);
      expect(got.wire, nameOf(a, id)).not.toContain(id);
      expect(got.wire, nameOf(a, id)).not.toContain(appTitle(id));
    }
  });

  it('never answers a folder that holds nothing the member may run, shared or not', async () => {
    const got = await launcher('team');
    // Admin apps only; drafts only in a folder shared with the team; the
    // admin-only side folder of a folder the member does see.
    for (const id of [f.hidden, f.drafts, f.side]) {
      expect(byId(got.folders, id), nameOf(f, id)).toBeUndefined();
      expect(got.wire, nameOf(f, id)).not.toContain(id);
      expect(got.wire, nameOf(f, id)).not.toContain(folderName(id));
    }
  });

  it('answers the folders on the way to an app, each under its parent', async () => {
    const got = await launcher('team');
    expect(byId(got.folders, f.deep)).toMatchObject({ parentId: null, appIds: [] });
    expect(byId(got.folders, f.mid)).toMatchObject({ parentId: f.deep, appIds: [] });
    expect(byId(got.folders, f.leaf)).toMatchObject({ parentId: f.mid, appIds: [a.teamDeep] });
  });

  it('leaves an app at the top level in no folder, and carries no path or level', async () => {
    const got = await launcher('team');
    expect(byId(got.apps, a.teamTop)).toBeDefined();
    expect(got.folders.some((x) => x.appIds.includes(a.teamTop))).toBe(false);
    for (const x of got.folders) {
      expect(Object.keys(x).sort()).toEqual(['appIds', 'color', 'icon', 'id', 'name', 'parentId']);
    }
    expect(got.wire).not.toContain(path.shared);
  });

  it('runs every app a member may run in a shared folder (the client launcher went in W5c)', async () => {
    expect(byId((await launcher('team')).folders, f.parent)?.appIds.sort()).toEqual(
      [a.clientInParent, a.adminInParent, a.publicInParent].sort(),
    );
  });

  it('drops the app and its folder when Team no longer holds the folder', async () => {
    await holdTeam(f.shared, false);
    try {
      const got = await launcher('team');
      expect(byId(got.apps, a.adminInShared)).toBeUndefined();
      expect(byId(got.folders, f.shared)).toBeUndefined();
      expect(got.wire).not.toContain(folderName(f.shared));
    } finally {
      await holdTeam(f.shared, true);
    }
    expect(byId((await launcher('team')).folders, f.shared)).toBeDefined();
  });

  it('never answers another owner’s rows, or a member’s own folder, at the same path', async () => {
    for (const reader of ['team'] as const) {
      const got = await launcher(reader);
      for (const id of Object.values(foreign)) {
        expect(got.wire, `${reader} ${nameOf(foreign, id)}`).not.toContain(id);
        expect(got.wire, `${reader} ${nameOf(foreign, id)}`).not.toContain(foreignName(id));
      }
    }
    // The path still answers this brain's own folder, once.
    const got = await launcher('team');
    expect(got.folders.filter((x) => x.name === folderName(f.shared))).toHaveLength(1);
  });

  it('does not run an app that is only read through an embed, and names no folder for it', async () => {
    const [row] = (await m.systemDb.execute(sqlTag`
      select audience, inherited_level, embedded_level from nodes
       where id = ${a.embeddedOnly}`)) as unknown as Array<Record<string, string | null>>;
    // The fixture holds: an archived embed level, and no Team grant.
    expect(row).toEqual({ audience: 'admin', inherited_level: null, embedded_level: 'team' });
    const [held] = (await m.systemDb.execute(sqlTag`
      select ${team}::uuid = any(read_ws) as team from nodes
       where id = ${a.embeddedOnly}`)) as unknown as Array<{ team: boolean }>;
    expect(held?.team).toBe(false);
    const got = await launcher('team');
    expect(byId(got.apps, a.embeddedOnly)).toBeUndefined();
    expect(byId(got.folders, f.embedded)).toBeUndefined();
    expect(got.wire).not.toContain(a.embeddedOnly);
    expect(got.wire).not.toContain(folderName(f.embedded));
  });

  it('refuses to run inside a viewer scope', async () => {
    // The member's own workspace scope (the level scope went in W8c).
    await expect(
      m.withViewer({ login: member }, () => folders.appLauncher(brain, 'team', member)),
    ).rejects.toThrow(/admin pool/);
  });
});
