/**
 * A member's Apps tree (docs/folder-tree.md, "Apps for members"): apps are a
 * reader tree kind, so a member's Apps screen is the tree. On a migrated
 * scratch brain on workspaces, as a member of one workspace:
 *
 *  - the tree lists exactly the apps the member's Apps list lists (listApps,
 *    GET /api/apps), drafts too, walked folder by folder; an app granted
 *    only to a workspace the member is not in is absent;
 *  - a team app in a folder nobody shared shows in its folder (the folder
 *    comes as the way to it), two levels down too, with the folder and item
 *    counts the member reads; a folder of admin apps and an empty unshared
 *    folder beside the way are absent and do not open by id, while an empty
 *    folder granted to the member's workspace lists;
 *  - search and crumbs name the same folders, no other;
 *  - the owner still sees every folder and app.
 *
 * The route's own writes on a member's read (ensureTreeRoot: the kind root,
 * its own app marks, and no layout move, which waits for an Admin user) are
 * pinned through the real route by w6a-route-sweep.db.test.ts (a package
 * test opens no request, where the kind root's system write may run). There is
 * no client login to test (0272 refuses the role).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-member-apps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Treat the member's scope as a session of its login, so the tree asks the
 *  trail definer (in the app a cookie or bearer session decides that, which a
 *  package test has none of). */
const hook = vi.hoisted(() => ({ trail: false }));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  const { sql } = await import('drizzle-orm');
  type Ask = Parameters<typeof orig.folderTrail>[1];
  // The definer call folderTrailSql makes, without its own caller check
  // (which reads the module's trailForCaller, not this one).
  const trailSql = (ownerId: string, ask: Ask) =>
    sql`(select r.id, r.path::ltree as path, r.title
           from "public"."mantle_folder_trail"(${ownerId}::uuid, ${ask.under ?? null}::text,
                                               ${orig.textArraySql(ask.paths ?? [])},
                                               ${ask.folder ?? null}::uuid) r)`;
  return {
    ...orig,
    trailForCaller: (ownerId: string) => (hook.trail ? true : orig.trailForCaller(ownerId)),
    folderTrailSql: (ownerId: string, ask: Ask) =>
      hook.trail ? trailSql(ownerId, ask) : orig.folderTrailSql(ownerId, ask),
    folderTrail: async (ownerId: string, ask: Ask) => {
      if (!hook.trail) return orig.folderTrail(ownerId, ask);
      return (await orig.db.execute(
        sql`select t.id::text as id, t.path::text as path, t.title from ${trailSql(ownerId, ask)} t`,
      )) as unknown as Awaited<ReturnType<typeof orig.folderTrail>>;
    },
  };
});

describe.skipIf(!URL)('a member’s Apps tree', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let appsMod: typeof import('../apps');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const member = randomUUID();
  const W = randomUUID();
  /** A workspace of the brain the member is not in. */
  const W2 = randomUUID();
  const tag = `ma${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // team: a folder nobody shared, holding a team app granted to W;
  // admin: a folder nobody shared, holding an app nobody granted;
  // deep > mid: two folders nobody shared, mid holding a team app; deep >
  // side: an empty folder nobody shared, beside the way;
  // shared: an empty folder granted to W;
  // at the root, one app granted to W, one not, one granted only to W2.
  // Every app is a draft (no published build).
  const F = {
    team: randomUUID(),
    admin: randomUUID(),
    deep: randomUUID(),
    mid: randomUUID(),
    side: randomUUID(),
    shared: randomUUID(),
  };
  const P: Record<keyof typeof F, string> = {
    team: 'apps.team',
    admin: 'apps.admin',
    deep: 'apps.deep',
    mid: 'apps.deep.mid',
    side: 'apps.deep.side',
    shared: 'apps.shared',
  };
  const A = {
    inTeam: randomUUID(),
    inAdmin: randomUUID(),
    inMid: randomUUID(),
    rootTeam: randomUUID(),
    rootAdmin: randomUUID(),
    rootOther: randomUUID(),
  };

  const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const asMember = <T>(fn: () => Promise<T>) => {
    hook.trail = true;
    return m.withViewer({ login: member }, fn).finally(() => {
      hook.trail = false;
    });
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tree = await import('./index');
    appsMod = await import('../apps');
    sqlTag = (await import('drizzle-orm')).sql;
    const su = (q: ReturnType<typeof sqlTag>) => ts.superuserExec(scratch!.url, q);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', false)`);
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W2}, ${owner}, ${`${tag} W2`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id = ${member}`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${W}, ${member}, false)`);
    await tree.ensureKindRoot(owner, 'apps');
    for (const [key, id] of Object.entries(F)) {
      const p = P[key as keyof typeof F];
      await m.withNodeInsertHeads(owner, [{ type: 'branch', path: p }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, slug, path, data)
          values (${id}, ${owner}, 'branch', ${`${tag} ${key}`}, ${key}, ${p}::ltree,
                  ${JSON.stringify({ slug: key })}::jsonb)`),
      );
    }
    const placed: [string, string][] = [
      [A.inTeam, P.team],
      [A.inAdmin, P.admin],
      [A.inMid, P.mid],
      [A.rootTeam, 'apps'],
      [A.rootAdmin, 'apps'],
      [A.rootOther, 'apps'],
    ];
    for (const [id, p] of placed) {
      await m.withNodeInsertHeads(owner, [{ type: 'app', path: p }], async (tx) => {
        await tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${id}, ${owner}, 'app', ${`${tag} app ${id.slice(0, 6)}`}, ${p}::ltree)`);
        await tx.execute(sqlTag`insert into apps (node_id) values (${id})`);
      });
    }
    const grants: [string, string][] = [
      [A.inTeam, W],
      [A.rootTeam, W],
      [A.inMid, W],
      [F.shared, W],
      [A.rootOther, W2],
    ];
    for (const [id, ws] of grants) {
      await m.withHeads([id], 'update', async (tx) => {
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id) values (${id}, ${ws})`,
        );
      });
    }
  }, 240_000);

  /** Every app id the member's tree lists, walked folder by folder from the
   *  root, and every folder id it walked. */
  const walk = async () => {
    const apps = new Set<string>();
    const folders = new Set<string>();
    const open = async (folderId: string | null) => {
      const page = await asMember(() =>
        tree.loadTreeFolder(owner, 'apps', { folderId, limit: 100 }),
      );
      expect(page, `folder ${folderId}`).not.toBe(null);
      expect(page!.nextCursor).toBe(null);
      for (const i of page!.items) apps.add(i.id);
      for (const f of page!.folders) {
        folders.add(f.id);
        await open(f.id);
      }
    };
    await open(null);
    return { apps, folders };
  };

  afterAll(async () => {
    hook.trail = false;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('apps are a reader tree kind', () => {
    expect(tree.READER_TREE_KINDS).toContain('apps');
  });

  it('the root: the folders on the way and the shared one; the team app at the root, no other', async () => {
    const page = await asMember(() => tree.loadTreeFolder(owner, 'apps'));
    expect(new Set(page?.folders.map((f) => f.id))).toEqual(new Set([F.team, F.deep, F.shared]));
    // Neither the admin app nor the app of a workspace the member is not in.
    expect(page?.items.map((i) => i.id)).toEqual([A.rootTeam]);
    const byId = new Map(page!.folders.map((f) => [f.id, f]));
    // The counts the member reads: deep shows mid (the way on), no item;
    // team its one app; the shared folder is empty.
    expect(byId.get(F.deep)).toMatchObject({ folderCount: 1, itemCount: 0, parentId: null });
    expect(byId.get(F.team)).toMatchObject({ folderCount: 0, itemCount: 1 });
    expect(byId.get(F.shared)).toMatchObject({ folderCount: 0, itemCount: 0 });
  });

  it('two levels down: deep opens on mid only (not the empty side folder), mid on its app', async () => {
    const deep = await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.deep }));
    expect(deep?.folders.map((f) => f.id)).toEqual([F.mid]);
    expect(deep?.items).toEqual([]);
    expect(deep?.folders[0]).toMatchObject({ folderCount: 0, itemCount: 1, parentId: F.deep });
    const mid = await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.mid }));
    expect(mid?.items.map((i) => i.id)).toEqual([A.inMid]);
    expect(mid?.crumbs.map((c) => c.id)).toEqual([F.deep]);
    expect(await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.side }))).toBe(
      null,
    );
  });

  it('crumbs name the folders on the way, never one beside it or above nothing', async () => {
    const crumbs = await asMember(() =>
      tree.treeCrumbsFor(owner, [P.mid, P.side, P.admin, P.team]),
    );
    expect(crumbs.get(P.mid)?.map((c) => c.id)).toEqual([F.deep, F.mid]);
    expect(crumbs.get(P.side)?.map((c) => c.id)).toEqual([F.deep]);
    expect(crumbs.get(P.admin)).toEqual([]);
    expect(crumbs.get(P.team)?.map((c) => c.id)).toEqual([F.team]);
  });

  it('search finds the apps the member reads, with their crumbs, and the folder it reads', async () => {
    const hit = await asMember(() => tree.searchTree(owner, 'apps', tag, { limit: 100 }));
    expect(new Set(hit.items.map((i) => i.id))).toEqual(new Set([A.inTeam, A.inMid, A.rootTeam]));
    expect(hit.items.find((i) => i.id === A.inMid)?.crumbs.map((c) => c.id)).toEqual([
      F.deep,
      F.mid,
    ]);
    expect(hit.items.find((i) => i.id === A.inTeam)?.crumbs.map((c) => c.id)).toEqual([F.team]);
    // Folders match by name only where the member reads them.
    expect(hit.folders.map((f) => f.id)).toEqual([F.shared]);
  });

  it('the unshared folder opens on the team app; the admin folder does not open', async () => {
    const team = await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.team }));
    expect(team?.items.map((i) => i.id)).toEqual([A.inTeam]);
    expect(await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.admin }))).toBe(
      null,
    );
  });

  it('the tree lists the same apps as the member’s Apps list, drafts too', async () => {
    const listed = new Set((await asMember(() => appsMod.listApps(owner))).map((a) => a.id));
    const walked = await walk();
    expect(walked.apps).toEqual(listed);
    expect(listed).toEqual(new Set([A.inTeam, A.inMid, A.rootTeam]));
    expect(walked.folders).toEqual(new Set([F.team, F.deep, F.mid, F.shared]));
    // Every one a draft: no published build.
    const published = (await x(sqlTag`select node_id from apps
      where node_id in (${A.inTeam}, ${A.inMid}, ${A.rootTeam})
        and published_build is not null`)) as unknown as unknown[];
    expect(published).toEqual([]);
  });

  it('the owner sees every folder and app', async () => {
    const root = await tree.loadTreeFolder(owner, 'apps');
    expect(new Set(root?.folders.map((f) => f.id))).toEqual(
      new Set([F.team, F.admin, F.deep, F.shared]),
    );
    expect(new Set(root?.items.map((i) => i.id))).toEqual(
      new Set([A.rootTeam, A.rootAdmin, A.rootOther]),
    );
    const deep = await tree.loadTreeFolder(owner, 'apps', { folderId: F.deep });
    expect(new Set(deep?.folders.map((f) => f.id))).toEqual(new Set([F.mid, F.side]));
  });
});
