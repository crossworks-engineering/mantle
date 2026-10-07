/**
 * The Apps launcher for members and clients, on a real, migrated Postgres
 * (./app-folders.ts, `appLauncher`): the apps are read as the real team and
 * client roles, and the folders are the brain's rows on the way to those
 * apps and nothing else, as the routes answer them (GET /api/member/apps,
 * /api/client/apps).
 *
 *  - a member sees a team app inside a folder shared with the team, with the
 *    folder's name, icon and colour;
 *  - a member does not see an admin-only app that sits next to a team app,
 *    nor a draft (no published build) in a shared folder;
 *  - a folder that holds only admin-only apps, or only drafts, is not
 *    answered at all: not its name, not its id, shared or not;
 *  - the folders on the way to an app come with it, each under its parent;
 *  - a client sees a folder only through an app at CLIENT level (its own, or
 *    a folder shared with clients): a client app in a team-shared folder
 *    under an unshared one names both, and the team and public apps next to
 *    it are never named;
 *  - when a folder stops sharing, its apps and the folder go;
 *  - another owner's folder at the same path, and a member's own folder
 *    there, are never answered;
 *  - an app read only through an embed is not run, and names no folder.
 *
 * Rows belong to the shared test anchor, under folders of this run's own,
 * and carry this run's label (other files use the anchor in parallel, so
 * answers are narrowed by it). Every folder is inserted in one statement
 * with what it holds, so it never sits in the anchor empty.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-folders.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Apps launcher folders for members and clients', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let folders: typeof import('./app-folders');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
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
    /** Admin, published, in the folder shared with clients. */
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
      insert into nodes (id, owner_id, type, title, path, audience, data, tags)
      values ${sqlTag.join(
        rows.map(
          (r) => sqlTag`(${r.id}, ${r.owner}, ${r.type}::node_type, ${r.title}, ${r.at}::ltree,
                         ${r.audience ?? 'admin'}, ${JSON.stringify(r.data ?? {})}::jsonb, '{}')`,
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
  const appRow = (id: string, at: string, audience: string): NodeRow => ({
    id,
    owner: brain,
    type: 'app',
    title: appTitle(id),
    at,
    audience,
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
  const share = (id: string, level: string | null) =>
    m.systemDb.execute(sqlTag`update nodes set share_level = ${level} where id = ${id}`);

  const ourFolders = new Set<string>(Object.values(f));
  const ourApps = new Set<string>(Object.values(a));
  /** What the route answers for a reader, narrowed to this run's rows. */
  const launcher = async (reader: 'team' | 'client') => {
    const all: {
      apps: Array<{ id: string }>;
      folders: Awaited<ReturnType<typeof folders.appLauncher>>['folders'];
    } =
      reader === 'team'
        ? await folders.appLauncher(brain, 'team')
        : await folders.appLauncher(brain, 'client');
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
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    folders = await import('./app-folders');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
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
      appRow(a.adminInShared, path.shared, 'admin'),
      appRow(a.draftInShared, path.shared, 'admin'),
      appRow(a.teamInPlain, path.plain, 'team'),
      appRow(a.clientInPlain, path.plain, 'client'),
      appRow(a.adminInPlain, path.plain, 'admin'),
      appRow(a.adminHidden, path.hidden, 'admin'),
      appRow(a.draftOnly, path.drafts, 'team'),
      appRow(a.teamDeep, path.leaf, 'team'),
      appRow(a.adminSide, path.side, 'admin'),
      appRow(a.adminInClient, path.client, 'admin'),
      appRow(a.teamTop, 'apps', 'team'),
      appRow(a.clientInParent, path.parent, 'client'),
      appRow(a.adminInParent, path.parent, 'admin'),
      appRow(a.publicInParent, path.parent, 'public'),
      appRow(a.embeddedOnly, path.embedded, 'admin'),
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

    await share(f.shared, 'team');
    await share(f.drafts, 'team');
    await share(f.client, 'client');
    await share(f.parent, 'team');

    // A note in a notes folder shared with the team embeds the app: the app
    // is then READ at team (migration 0208), which must not make it run. The
    // folder and its note in one statement, for the same reason as above.
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
    await share(notesFolder, 'team');

    // Another brain with a folder and a team app at one of our paths, and a
    // member's own folder there: rows of other owners at the same path.
    await m.systemDb.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role, display_name) values
        (${other}, ${`${label}-other@example.invalid`}, 'x', 'admin', null),
        (${member}, ${`${label}-pat@example.invalid`}, 'x', 'member', 'Pat Member')`);
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
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${brain} and (
        id = ${a.teamTop}
        or path <@ ${path.shared}::ltree or path <@ ${path.plain}::ltree
        or path <@ ${path.hidden}::ltree or path <@ ${path.drafts}::ltree
        or path <@ ${path.deep}::ltree or path <@ ${path.client}::ltree
        or path <@ ${path.grand}::ltree or path <@ ${path.embedded}::ltree
        or path <@ ${path.notes}::ltree)`);
    await m.systemDb.execute(
      sqlTag`delete from nodes where owner_id in (${other}, ${memberSpace})`,
    );
    await m.systemDb.execute(sqlTag`delete from spaces where login_id in (${other}, ${member})`);
    await m.systemDb.execute(sqlTag`delete from auth.users where id in (${other}, ${member})`);
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

  it('shows a member a team app inside a folder shared with the team, with the folder’s look', async () => {
    const got = await launcher('team');
    expect(byId(got.apps, a.adminInShared)).toMatchObject({ audience: 'team' });
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

  it('shows a client only the folders that lead to an app at client level', async () => {
    const got = await launcher('client');
    expect(got.apps.map((x) => x.id).sort()).toEqual(
      [a.adminInClient, a.clientInPlain, a.clientInParent].sort(),
    );
    expect(got.folders.map((x) => `${x.id} ${x.parentId} ${x.appIds.join(',')}`).sort()).toEqual(
      [
        `${f.client} null ${a.adminInClient}`,
        `${f.plain} null ${a.clientInPlain}`,
        `${f.grand} null `,
        `${f.parent} ${f.grand} ${a.clientInParent}`,
      ].sort(),
    );
    // Not the team folder, the deep chain, or anything of the admin's.
    for (const id of [f.shared, f.hidden, f.drafts, f.deep, f.mid, f.leaf, f.side, f.embedded]) {
      expect(got.wire, nameOf(f, id)).not.toContain(id);
      expect(got.wire, nameOf(f, id)).not.toContain(folderName(id));
    }
    for (const id of [a.adminInShared, a.teamInPlain, a.teamDeep, a.teamTop, a.adminInPlain]) {
      expect(got.wire, nameOf(a, id)).not.toContain(id);
    }
  });

  it('names a client the team-shared folder and the unshared one above its client app, and no app of theirs it may not run', async () => {
    const got = await launcher('client');
    // Names are organisational: both folders on the way come, by name.
    expect(byId(got.folders, f.grand)).toMatchObject({ name: folderName(f.grand), parentId: null });
    expect(byId(got.folders, f.parent)).toMatchObject({
      name: folderName(f.parent),
      parentId: f.grand,
      appIds: [a.clientInParent],
    });
    // The team app (an admin app the folder shares with the team) and the
    // public app in the same folder are never named to the client.
    for (const id of [a.adminInParent, a.publicInParent]) {
      expect(got.wire, nameOf(a, id)).not.toContain(id);
      expect(got.wire, nameOf(a, id)).not.toContain(appTitle(id));
    }
    // A member runs all three there.
    expect(byId((await launcher('team')).folders, f.parent)?.appIds.sort()).toEqual(
      [a.clientInParent, a.adminInParent, a.publicInParent].sort(),
    );
  });

  it('drops the app and its folder when the folder stops sharing', async () => {
    await share(f.shared, null);
    try {
      const got = await launcher('team');
      expect(byId(got.apps, a.adminInShared)).toBeUndefined();
      expect(byId(got.folders, f.shared)).toBeUndefined();
      expect(got.wire).not.toContain(folderName(f.shared));
    } finally {
      await share(f.shared, 'team');
    }
    expect(byId((await launcher('team')).folders, f.shared)).toBeDefined();
  });

  it('never answers another owner’s rows, or a member’s own folder, at the same path', async () => {
    for (const reader of ['team', 'client'] as const) {
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
    // The fixture holds: the app is read at team through the note, and by
    // nothing else.
    expect(row).toEqual({ audience: 'admin', inherited_level: null, embedded_level: 'team' });
    const got = await launcher('team');
    expect(byId(got.apps, a.embeddedOnly)).toBeUndefined();
    expect(byId(got.folders, f.embedded)).toBeUndefined();
    expect(got.wire).not.toContain(a.embeddedOnly);
    expect(got.wire).not.toContain(folderName(f.embedded));
  });

  it('refuses to run inside a viewer scope', async () => {
    await expect(m.withViewer('team', () => folders.appLauncher(brain, 'team'))).rejects.toThrow(
      /admin pool/,
    );
  });
});
