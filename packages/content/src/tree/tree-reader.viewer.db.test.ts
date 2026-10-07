/**
 * The member and client trees (folder plan phase 4): what a member (team) or
 * a client login sees of a kind's folders. Items are read as that reader
 * (row security, the Library's levels by the union rule); a folder shows
 * when its share covers the reader or when it is on the way to something the
 * reader reads. Counts are the reader's. A folder the reader cannot see is
 * not found, by id or by search. A client's shape carries no level.
 *
 * Rows belong to the shared test anchor, under folders of this run's own
 * (other files use the anchor in parallel, so lists are narrowed to them).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-reader.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the member and client trees', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./index');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
  const label = `rt${randomUUID().slice(0, 8)}`;
  const P = {
    top: `notes.${label}_top`,
    team: `notes.${label}_top.team`,
    deep: `notes.${label}_top.team.deep`,
    client: `notes.${label}_top.client`,
    hidden: `notes.${label}_top.hidden`,
    hasTeam: `notes.${label}_top.hasteam`,
    private: `notes.${label}_private`,
  };
  const f = {
    top: randomUUID(),
    team: randomUUID(),
    deep: randomUUID(),
    client: randomUUID(),
    hidden: randomUUID(),
    hasTeam: randomUUID(),
    private: randomUUID(),
  };
  const i = {
    /** Admin, in the team-shared folder. */
    inTeam: randomUUID(),
    /** Admin, in the client-shared folder. */
    inClient: randomUUID(),
    /** Admin, in a folder nobody shared. */
    inHidden: randomUUID(),
    /** Team by its own level, in a folder nobody shared. */
    teamOwn: randomUUID(),
    /** Team by its own level, at the kind's root. */
    rootTeam: randomUUID(),
    /** Admin, in the private folder. */
    inPrivate: randomUUID(),
  };

  const node = async (
    id: string,
    type: string,
    path: string,
    title: string,
    audience = 'admin',
  ) => {
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data, tags)
      values (${id}, ${brain}, ${type}::node_type, ${title}, ${path}::ltree, ${audience},
              ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb, '{}')`);
  };
  const ours = new Set<string>([...Object.values(f), ...Object.values(i)]);
  const mine = <T extends { id: string }>(rows: T[]) => rows.filter((r) => ours.has(r.id));
  const ids = (rows: { id: string }[]) => mine(rows).map((r) => r.id);
  const open = (reader: 'team' | 'client', folderId: string | null) =>
    tree.loadReaderTreeFolder(brain, reader, 'notes', { folderId });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'notes');
    await node(f.top, 'branch', P.top, `${label} Top`);
    await node(f.team, 'branch', P.team, `${label} Team`);
    await node(f.deep, 'branch', P.deep, `${label} Deep`);
    await node(f.client, 'branch', P.client, `${label} Client`);
    await node(f.hidden, 'branch', P.hidden, `${label} Hidden`);
    await node(f.hasTeam, 'branch', P.hasTeam, `${label} Has team`);
    await node(f.private, 'branch', P.private, `${label} Private`);
    await node(i.inTeam, 'note', P.team, `${label} in team`);
    await node(i.inClient, 'note', P.client, `${label} in client`);
    await node(i.inHidden, 'note', P.hidden, `${label} in hidden`);
    await node(i.teamOwn, 'note', P.hasTeam, `${label} team own`, 'team');
    await node(i.rootTeam, 'note', 'notes', `${label} root team`, 'team');
    await node(i.inPrivate, 'note', P.private, `${label} in private`);
    await m.systemDb.execute(sqlTag`update nodes set share_level = 'team' where id = ${f.team}`);
    await m.systemDb.execute(
      sqlTag`update nodes set share_level = 'client' where id = ${f.client}`,
    );
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${brain} and (
        path <@ ${P.top}::ltree or path <@ ${P.private}::ltree
        or id = ${i.rootTeam})`);
  });

  it('shows a member the folders on the way to what they read, with their counts', async () => {
    const root = (await open('team', null))!;
    expect(ids(root.folders)).toEqual([f.top]);
    expect(ids(root.items)).toEqual([i.rootTeam]);
    // Top holds three folders a member sees (not Hidden) and no item.
    expect(mine(root.folders)[0]).toMatchObject({ folderCount: 3, itemCount: 0 });

    const top = (await open('team', f.top))!;
    expect(ids(top.folders)).toEqual([f.client, f.hasTeam, f.team]);
    const byId = new Map(top.folders.map((x) => [x.id, x]));
    expect(byId.get(f.team)).toMatchObject({ share: 'team', folderCount: 1, itemCount: 1 });
    expect(byId.get(f.hasTeam)).toMatchObject({ folderCount: 0, itemCount: 1 });
    expect(top.crumbs).toEqual([]);

    const team = (await open('team', f.team))!;
    expect(ids(team.folders)).toEqual([f.deep]);
    expect(ids(team.items)).toEqual([i.inTeam]);
    expect(team.items[0]).toMatchObject({ level: 'team', inherited: 'team' });
    expect(team.crumbs).toEqual([{ id: f.top, name: `${label} Top` }]);
    // A shared folder's empty subfolder still shows: the share covers it.
    const deep = (await open('team', f.deep))!;
    expect(deep.items).toEqual([]);
  });

  it('never finds a folder a member cannot see, nor lists its items', async () => {
    expect(await open('team', f.hidden)).toBeNull();
    expect(await open('team', f.private)).toBeNull();
    expect(await open('team', randomUUID())).toBeNull();
  });

  it('shows a client only the way to what is shared with clients', async () => {
    const root = (await open('client', null))!;
    expect(ids(root.folders)).toEqual([f.top]);
    expect(ids(root.items)).toEqual([]);
    expect(mine(root.folders)[0]).toMatchObject({ folderCount: 1, itemCount: 0 });
    const top = (await open('client', f.top))!;
    expect(ids(top.folders)).toEqual([f.client]);
    const client = (await open('client', f.client))!;
    expect(ids(client.items)).toEqual([i.inClient]);
    for (const hidden of [f.team, f.deep, f.hasTeam, f.hidden, f.private]) {
      expect(await open('client', hidden)).toBeNull();
    }
  });

  it('gives a client no level, share or system field', async () => {
    const page = tree.clientTreeFolderPage((await open('client', f.client))!);
    const item = page.items.find((x) => x.id === i.inClient)!;
    for (const k of ['level', 'inherited', 'state']) expect(item).not.toHaveProperty(k);
    for (const k of ['share', 'inherited', 'system']) expect(page.folder).not.toHaveProperty(k);
    const root = tree.clientTreeFolderPage((await open('client', f.top))!);
    for (const k of ['share', 'inherited', 'system']) expect(root.folders[0]).not.toHaveProperty(k);
  });

  it('searches as the reader: folders it may see, items it may read', async () => {
    const member = await tree.searchReaderTree(brain, 'team', 'notes', label);
    expect(ids(member.folders).sort()).toEqual([f.top, f.team, f.deep, f.client, f.hasTeam].sort());
    expect(ids(member.items).sort()).toEqual([i.inTeam, i.inClient, i.teamOwn, i.rootTeam].sort());
    const hit = member.items.find((x) => x.id === i.inTeam)!;
    expect(hit.crumbs.map((c) => c.id)).toEqual([f.top, f.team]);

    const client = await tree.searchReaderTree(brain, 'client', 'notes', label);
    expect(ids(client.folders).sort()).toEqual([f.top, f.client].sort());
    expect(ids(client.items)).toEqual([i.inClient]);
  });

  it('follows a share as it changes', async () => {
    await m.systemDb.execute(sqlTag`update nodes set share_level = null where id = ${f.client}`);
    try {
      expect(await open('client', f.client)).toBeNull();
      expect(ids((await open('client', null))!.folders)).toEqual([]);
    } finally {
      await m.systemDb.execute(
        sqlTag`update nodes set share_level = 'client' where id = ${f.client}`,
      );
    }
  });
});
