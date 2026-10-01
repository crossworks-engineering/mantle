/**
 * The Apps launcher's folders for members and clients, on a real, migrated
 * Postgres (./app-folders.ts): the apps are read inside withViewer, as the
 * real team and client roles, and the folders are built from those apps
 * alone, as the routes do (GET /api/member/apps, /api/client/apps).
 *
 *  - a member sees a team app inside a folder shared with the team, with the
 *    folder's name, icon and colour;
 *  - a member does not see an admin-only app that sits next to a team app,
 *    nor a draft (no published build) in a shared folder;
 *  - a folder that holds only admin-only apps, or only drafts, is not
 *    answered at all: not its name, not its id, shared or not;
 *  - the folders on the way to an app come with it, each under its parent;
 *  - a client sees a folder only through an app at CLIENT level (its own, or
 *    a folder shared with clients), never a team folder;
 *  - when a folder stops sharing, its apps and the folder go.
 *
 * Rows belong to the shared test anchor, under folders of this run's own,
 * and carry this run's label (other files use the anchor in parallel, so
 * answers are narrowed by it).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/app-folders.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppPlace } from './app-folders';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the Apps launcher folders for members and clients', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let folders: typeof import('./app-folders');
  let memberApps: typeof import('./member-apps');
  let clientApps: typeof import('./client-apps');
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
  };
  const nameOf = (ids: Record<string, string>, id: string) =>
    `${label} ${Object.entries(ids).find(([, v]) => v === id)![0]}`;
  const folderName = (id: string) => `${nameOf(f, id)} folder`;
  const appTitle = (id: string) => `${nameOf(a, id)} app`;

  const folder = async (id: string, at: string, data: Record<string, unknown> = {}) => {
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data, tags)
      values (${id}, ${brain}, 'branch', ${folderName(id)}, ${at}::ltree, 'admin',
              ${JSON.stringify(data)}::jsonb, '{}')`);
  };
  const app = async (id: string, at: string, audience: string, published: boolean) => {
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data, tags)
      values (${id}, ${brain}, 'app', ${appTitle(id)}, ${at}::ltree, ${audience}, '{}'::jsonb, '{}')`);
    const green = JSON.stringify({
      storageKey: 'apps/x.js',
      sha256: 'x',
      builtAt: '2026-10-01T00:00:00Z',
      esbuildVersion: '0',
      bytes: 1,
      ok: true,
    });
    await m.systemDb.execute(sqlTag`
      insert into apps (node_id, manifest, published_build, draft_build)
      values (${id}, '{}'::jsonb, ${published ? green : null}::jsonb, ${green}::jsonb)`);
  };
  const share = (id: string, level: string | null) =>
    m.systemDb.execute(sqlTag`update nodes set share_level = ${level} where id = ${id}`);

  const ourFolders = new Set<string>(Object.values(f));
  const ourApps = new Set<string>(Object.values(a));
  /** What the route answers for a reader, narrowed to this run's rows. */
  const launcher = async (reader: 'team' | 'client') => {
    const { apps, places }: { apps: Array<{ id: string }>; places: AppPlace[] } =
      reader === 'team'
        ? await m.withViewer('team', () => memberApps.listMemberAppsPlaced(brain))
        : await m.withViewer('client', () => clientApps.listClientAppsPlaced(brain));
    const all = await folders.appLauncherFolders(brain, places);
    return {
      apps: apps.filter((x) => ourApps.has(x.id)),
      folders: all
        .filter((x) => ourFolders.has(x.id))
        .map((x) => ({ ...x, appIds: x.appIds.filter((id) => ourApps.has(id)) })),
      /** Everything the reader is answered, as it goes over the wire. */
      wire: JSON.stringify({ apps, folders: all }),
    };
  };
  const byId = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    folders = await import('./app-folders');
    memberApps = await import('./member-apps');
    clientApps = await import('./client-apps');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'apps');

    await folder(f.shared, path.shared, { icon: 'lucide:rocket', color: 'teal' });
    await folder(f.plain, path.plain);
    await folder(f.hidden, path.hidden);
    await folder(f.drafts, path.drafts);
    await folder(f.deep, path.deep);
    await folder(f.mid, path.mid);
    await folder(f.leaf, path.leaf);
    await folder(f.side, path.side);
    await folder(f.client, path.client);

    await app(a.adminInShared, path.shared, 'admin', true);
    await app(a.draftInShared, path.shared, 'admin', false);
    await app(a.teamInPlain, path.plain, 'team', true);
    await app(a.clientInPlain, path.plain, 'client', true);
    await app(a.adminInPlain, path.plain, 'admin', true);
    await app(a.adminHidden, path.hidden, 'admin', true);
    await app(a.draftOnly, path.drafts, 'team', false);
    await app(a.teamDeep, path.leaf, 'team', true);
    await app(a.adminSide, path.side, 'admin', true);
    await app(a.adminInClient, path.client, 'admin', true);
    await app(a.teamTop, 'apps', 'team', true);

    await share(f.shared, 'team');
    await share(f.drafts, 'team');
    await share(f.client, 'client');
  }, 60_000);

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${brain} and (
        id = ${a.teamTop}
        or path <@ ${path.shared}::ltree or path <@ ${path.plain}::ltree
        or path <@ ${path.hidden}::ltree or path <@ ${path.drafts}::ltree
        or path <@ ${path.deep}::ltree or path <@ ${path.client}::ltree)`);
  }, 60_000);

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
    expect(got.apps.map((x) => x.id).sort()).toEqual([a.adminInClient, a.clientInPlain].sort());
    expect(got.folders.map((x) => `${x.id} ${x.parentId} ${x.appIds.join(',')}`).sort()).toEqual(
      [`${f.client} null ${a.adminInClient}`, `${f.plain} null ${a.clientInPlain}`].sort(),
    );
    // Not the team folder, the deep chain, or anything of the admin's.
    for (const id of [f.shared, f.hidden, f.drafts, f.deep, f.mid, f.leaf, f.side]) {
      expect(got.wire, nameOf(f, id)).not.toContain(id);
      expect(got.wire, nameOf(f, id)).not.toContain(folderName(id));
    }
    for (const id of [a.adminInShared, a.teamInPlain, a.teamDeep, a.teamTop, a.adminInPlain]) {
      expect(got.wire, nameOf(a, id)).not.toContain(id);
    }
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

  it('refuses to read folder rows inside a viewer scope', async () => {
    await expect(m.withViewer('team', () => folders.appLauncherFolders(brain, []))).rejects.toThrow(
      /admin pool/,
    );
  });
});
