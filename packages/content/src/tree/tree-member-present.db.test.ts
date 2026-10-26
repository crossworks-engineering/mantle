/**
 * A member's Present tree (docs/folder-tree.md, "Present for members"):
 * Present canvases are a reader tree kind, so a member's Present screen is
 * the tree. On a migrated scratch brain on workspaces, as a member of one
 * workspace:
 *
 *  - the tree lists exactly the canvases the member's Present list lists
 *    (listPresents, GET /api/presents), walked folder by folder;
 *  - a canvas granted only to a workspace the member is not in, and one
 *    homed in Admin, are absent, and neither reads by id (getPresent, the
 *    404 of GET /api/presents/:id and its frame ticket) nor as a frame
 *    (getPresentFrame);
 *  - a team canvas in a folder nobody shared shows in its folder (the
 *    trail), while a folder of admin canvases is absent and does not open
 *    by id;
 *  - the owner still sees every folder and canvas.
 *
 * The HTTP side (the frame ticket and the frame for a member) is pinned by
 * w6a-route-sweep.db.test.ts.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/content/src/tree/tree-member-present.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Treat the member's scope as a session of its login, so the tree asks the
 *  trail definer (as tree-member-apps.db.test.ts does). */
const hook = vi.hoisted(() => ({ trail: false }));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  const { sql } = await import('drizzle-orm');
  type Ask = Parameters<typeof orig.folderTrail>[1];
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

describe.skipIf(!URL)('a member’s Present tree', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tree: typeof import('./index');
  let presentsMod: typeof import('../presents');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const member = randomUUID();
  const W = randomUUID();
  /** A workspace of the brain the member is not in. */
  const W2 = randomUUID();
  const tag = `mp${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // team: a folder nobody shared, holding a canvas granted to W;
  // admin: a folder nobody shared, holding a canvas nobody granted;
  // at the root, one canvas granted to W, one homed in Admin, one granted
  // only to W2.
  const F = { team: randomUUID(), admin: randomUUID() };
  const C = {
    inTeam: randomUUID(),
    inAdmin: randomUUID(),
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
    presentsMod = await import('../presents');
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
    await tree.ensureKindRoot(owner, 'present');
    for (const [key, id] of Object.entries(F)) {
      const p = `present.${key}`;
      await m.withNodeInsertHeads(owner, [{ type: 'branch', path: p }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, slug, path, data)
          values (${id}, ${owner}, 'branch', ${`${tag} ${key}`}, ${key}, ${p}::ltree,
                  ${JSON.stringify({ slug: key })}::jsonb)`),
      );
    }
    const placed: [string, string][] = [
      [C.inTeam, 'present.team'],
      [C.inAdmin, 'present.admin'],
      [C.rootTeam, 'present'],
      [C.rootAdmin, 'present'],
      [C.rootOther, 'present'],
    ];
    for (const [id, p] of placed) {
      await m.withNodeInsertHeads(owner, [{ type: 'present', path: p }], async (tx) => {
        await tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${id}, ${owner}, 'present', ${`${tag} canvas ${id.slice(0, 6)}`}, ${p}::ltree)`);
        await tx.execute(sqlTag`insert into presents (node_id, source, meta)
          values (${id}, '<div>a8</div>', '{}'::jsonb)`);
      });
    }
    const grants: [string, string][] = [
      [C.inTeam, W],
      [C.rootTeam, W],
      [C.rootOther, W2],
    ];
    for (const [id, ws] of grants) {
      await m.withHeads([id], 'update', async (tx) => {
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id) values (${id}, ${ws})`,
        );
      });
    }
  }, 240_000);

  afterAll(async () => {
    hook.trail = false;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('Present is a reader tree kind', () => {
    expect(tree.READER_TREE_KINDS).toContain('present');
  });

  it('the root: the folder on the way to the team canvas, and the team canvas, no other', async () => {
    const page = await asMember(() => tree.loadTreeFolder(owner, 'present'));
    expect(page?.folders.map((f) => f.id)).toEqual([F.team]);
    expect(page?.folders[0]).toMatchObject({ folderCount: 0, itemCount: 1 });
    expect(page?.items.map((i) => i.id)).toEqual([C.rootTeam]);
  });

  it('the unshared folder opens on the team canvas; the admin folder does not open', async () => {
    const team = await asMember(() => tree.loadTreeFolder(owner, 'present', { folderId: F.team }));
    expect(team?.items.map((i) => i.id)).toEqual([C.inTeam]);
    expect(await asMember(() => tree.loadTreeFolder(owner, 'present', { folderId: F.admin }))).toBe(
      null,
    );
  });

  it('the tree lists the same canvases as the member’s Present list', async () => {
    const listed = new Set(
      (await asMember(() => presentsMod.listPresents(owner, { limit: 100 }))).map((p) => p.id),
    );
    const walked = new Set<string>();
    const open = async (folderId: string | null) => {
      const page = await asMember(() =>
        tree.loadTreeFolder(owner, 'present', { folderId, limit: 100 }),
      );
      expect(page, `folder ${folderId}`).not.toBe(null);
      for (const i of page!.items) walked.add(i.id);
      for (const f of page!.folders) await open(f.id);
    };
    await open(null);
    expect(walked).toEqual(listed);
    expect(listed).toEqual(new Set([C.inTeam, C.rootTeam]));
  });

  it('a canvas of another workspace or of Admin reads by id nowhere for the member', async () => {
    for (const id of [C.rootOther, C.rootAdmin, C.inAdmin]) {
      expect(await asMember(() => presentsMod.getPresent(owner, id)), id).toBe(null);
      expect(await asMember(() => presentsMod.getPresentFrame(owner, id)), id).toBe(null);
    }
    expect((await asMember(() => presentsMod.getPresent(owner, C.rootTeam)))?.id).toBe(C.rootTeam);
    expect(await asMember(() => presentsMod.getPresentFrame(owner, C.inTeam))).not.toBe(null);
  });

  it('search finds only the canvases the member reads', async () => {
    const hit = await asMember(() => tree.searchTree(owner, 'present', tag, { limit: 100 }));
    expect(new Set(hit.items.map((i) => i.id))).toEqual(new Set([C.inTeam, C.rootTeam]));
    expect(hit.items.find((i) => i.id === C.inTeam)?.crumbs.map((c) => c.id)).toEqual([F.team]);
    expect(hit.folders).toEqual([]);
  });

  it('the owner sees every folder and canvas', async () => {
    const root = await tree.loadTreeFolder(owner, 'present');
    expect(new Set(root?.folders.map((f) => f.id))).toEqual(new Set([F.team, F.admin]));
    expect(new Set(root?.items.map((i) => i.id))).toEqual(
      new Set([C.rootTeam, C.rootAdmin, C.rootOther]),
    );
  });
});
