/**
 * Folder-shared items in the member Library and the client's "Shared with
 * you" (folder plan phase 4, member and client trees): an item in a shared
 * folder is listed, opened and named in a client's redaction at the folder's
 * share, by the union rule the row policy uses (own level OR inherited share
 * in the reader's levels). Reads run inside withViewer, as the real team and
 * client roles.
 *
 * Rows belong to the shared test anchor, under folders of this run's own,
 * and carry this run's label in their titles (other files use the anchor in
 * parallel, so lists are narrowed by it).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/folder-share-lists.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('folder-shared items in the Library and for clients', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let tree: typeof import('./tree/index');
  let library: typeof import('./member-library');
  let shared: typeof import('./client-shared');
  let memberApps: typeof import('./member-apps');
  let clientApps: typeof import('./client-apps');
  let chat: typeof import('./chat-images');
  let sqlTag: typeof import('drizzle-orm').sql;
  let brain = '';
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

  const insert = async (id: string, type: string, path: string, audience = 'admin') => {
    await m.systemDb.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, audience, data, tags)
      values (${id}, ${brain}, ${type}::node_type, ${title(id)}, ${path}::ltree, ${audience},
              ${type === 'note' ? JSON.stringify({ content: 'x' }) : '{}'}::jsonb, '{}')`);
  };
  const share = (id: string, level: string | null) =>
    m.systemDb.execute(sqlTag`update nodes set share_level = ${level} where id = ${id}`);

  const listed = async (level: 'team' | 'client') =>
    m.withViewer(level, async () => {
      const res = await library.listLibrary(brain, { q: label, limit: 200 });
      return new Map(res.items.map((r) => [r.id, r.audience]));
    });
  const opens = (level: 'team' | 'client', id: string) =>
    m.withViewer(level, async () => (await library.getLibraryItem(brain, id)) !== null);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./tree/index');
    library = await import('./member-library');
    shared = await import('./client-shared');
    memberApps = await import('./member-apps');
    clientApps = await import('./client-apps');
    chat = await import('./chat-images');
    sqlTag = (await import('drizzle-orm')).sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(admin);
    await tree.ensureKindRoot(brain, 'notes');
    await tree.ensureKindRoot(brain, 'apps');
    await tree.ensureKindRoot(brain, 'files');
    await insert(ids.teamF, 'branch', teamPath);
    await insert(ids.clientF, 'branch', clientPath);
    await insert(ids.plainF, 'branch', plainPath);
    await insert(ids.adminInTeam, 'note', teamPath);
    await insert(ids.publicInTeam, 'note', teamPath, 'public');
    await insert(ids.adminInClient, 'note', clientPath);
    await insert(ids.teamInClient, 'note', clientPath, 'team');
    await insert(ids.adminPlain, 'note', plainPath);
    await insert(ids.appsTeamF, 'branch', appsTeamPath);
    await insert(ids.appsClientF, 'branch', appsClientPath);
    await insert(ids.filesClientF, 'branch', filesClientPath);
    await insert(ids.appInTeam, 'app', appsTeamPath);
    await insert(ids.appInClient, 'app', appsClientPath);
    await insert(ids.fileInClient, 'file', filesClientPath);
    await insert(ids.filePlain, 'file', plainPath);
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
    await share(ids.teamF, 'team');
    await share(ids.clientF, 'client');
    await share(ids.appsTeamF, 'team');
    await share(ids.appsClientF, 'client');
    await share(ids.filesClientF, 'client');
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`
      delete from nodes where owner_id = ${brain} and (
        path <@ ${teamPath}::ltree or path <@ ${clientPath}::ltree or path <@ ${plainPath}::ltree
        or path <@ ${appsTeamPath}::ltree or path <@ ${appsClientPath}::ltree
        or path <@ ${filesClientPath}::ltree)`);
  });

  it('lists folder-shared items in a member’s Library, badged Client when clients read them', async () => {
    const got = await listed('team');
    expect(got.get(ids.adminInTeam)).toBe('team');
    expect(got.get(ids.publicInTeam)).toBe('team');
    expect(got.get(ids.adminInClient)).toBe('client');
    expect(got.get(ids.teamInClient)).toBe('client');
    expect(got.has(ids.adminPlain)).toBe(false);
  });

  it('opens them for a member, never an unshared admin item', async () => {
    expect(await opens('team', ids.adminInTeam)).toBe(true);
    expect(await opens('team', ids.adminInClient)).toBe(true);
    expect(await opens('team', ids.adminPlain)).toBe(false);
  });

  it('lists and opens for a client only what a client-shared folder holds', async () => {
    const got = await m.withViewer('client', async () => {
      const res = await shared.listClientShared(brain, { q: label, limit: 200 });
      return new Set(res.items.map((r) => r.id));
    });
    expect([...got].sort()).toEqual([ids.adminInClient, ids.teamInClient, ids.fileInClient].sort());
    expect(await opens('client', ids.adminInClient)).toBe(true);
    expect(await opens('client', ids.teamInClient)).toBe(true);
    expect(await opens('client', ids.adminInTeam)).toBe(false);
    expect(await opens('client', ids.publicInTeam)).toBe(false);
    const item = await m.withViewer('client', () =>
      shared.getClientSharedItem(brain, ids.adminInClient),
    );
    expect(item).toMatchObject({ id: ids.adminInClient, type: 'note' });
    // The client's shape carries no level.
    expect(item && 'audience' in item).toBe(false);
  });

  it('keeps a folder-shared item named in a client’s redaction, and hides the rest', async () => {
    const readable = await m.withViewer('client', () =>
      shared.clientReadable(brain, [
        ids.adminInClient,
        ids.teamInClient,
        ids.adminInTeam,
        ids.adminPlain,
      ]),
    );
    expect([...readable.keys()].sort()).toEqual(
      [ids.adminInClient, ids.teamInClient].map((i) => i.toLowerCase()).sort(),
    );
    expect(readable.get(ids.adminInClient)).toBe(title(ids.adminInClient));
  });

  it('drops them again when the folder stops sharing', async () => {
    await share(ids.clientF, null);
    try {
      const got = await listed('team');
      expect(got.has(ids.adminInClient)).toBe(false);
      expect(got.get(ids.teamInClient)).toBe('team');
      expect(await opens('client', ids.teamInClient)).toBe(false);
    } finally {
      await share(ids.clientF, 'client');
    }
  });

  it('runs an admin app in a shared folder at the folder’s share', async () => {
    const team = await m.withViewer('team', () => memberApps.listMemberApps(brain));
    const inTeam = team.find((a) => a.id === ids.appInTeam);
    // Read at team through its folder: a member runs it and writes its data.
    expect(inTeam).toMatchObject({ audience: 'team', dataReadOnly: false });
    expect(team.find((a) => a.id === ids.appInClient)).toMatchObject({ audience: 'client' });
    const run = await m.withViewer('team', () =>
      memberApps.getMemberRunnableApp(brain, ids.appInTeam),
    );
    expect(run?.audience).toBe('team');
    // The team surfaces' app-data reach (admin pool).
    const teamIds = await memberApps.listTeamLevelAppIds(brain);
    expect(teamIds.has(ids.appInTeam) && teamIds.has(ids.appInClient)).toBe(true);

    const client = await m.withViewer('client', () => clientApps.listClientApps(brain));
    expect(client.map((a) => a.id)).toContain(ids.appInClient);
    expect(client.map((a) => a.id)).not.toContain(ids.appInTeam);
    expect(
      await m.withViewer('client', () => clientApps.getClientRunnableApp(brain, ids.appInClient)),
    ).not.toBeNull();
    expect(
      await m.withViewer('client', () => clientApps.getClientRunnableApp(brain, ids.appInTeam)),
    ).toBeNull();
  });

  it('shows a client a chat image from a folder shared with clients, not one outside', async () => {
    const got = await chat.chatImagesFor(brain, 'client', [ids.fileInClient, ids.filePlain]);
    expect([...got.keys()]).toEqual([ids.fileInClient.toLowerCase()]);
  });
});
