/**
 * A member's Apps tree (docs/folder-tree.md, "Apps for members"): apps are a
 * reader tree kind, so a member's Apps screen is the tree. On a migrated
 * scratch brain on workspaces, as a member of one workspace:
 *
 *  - the tree lists exactly the apps the member's Apps list lists (listApps,
 *    GET /api/apps), no more;
 *  - a team app in a folder nobody shared shows in its folder (the folder
 *    comes as the way to it), while a folder of admin apps is absent and
 *    does not open by id;
 *  - the owner still sees every folder and app.
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
  const tag = `ma${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // team: a folder nobody shared, holding a team app granted to W;
  // admin: a folder nobody shared, holding an app nobody granted;
  // at the root, one app granted to W and one not.
  const F = { team: randomUUID(), admin: randomUUID() };
  const A = {
    inTeam: randomUUID(),
    inAdmin: randomUUID(),
    rootTeam: randomUUID(),
    rootAdmin: randomUUID(),
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
    await su(sqlTag`delete from workspace_users where login_id = ${member}`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${W}, ${member}, false)`);
    await tree.ensureKindRoot(owner, 'apps');
    for (const [key, id] of Object.entries(F)) {
      const p = `apps.${key}`;
      await m.withNodeInsertHeads(owner, [{ type: 'branch', path: p }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, slug, path, data)
          values (${id}, ${owner}, 'branch', ${`${tag} ${key}`}, ${key}, ${p}::ltree,
                  ${JSON.stringify({ slug: key })}::jsonb)`),
      );
    }
    const placed: [string, string][] = [
      [A.inTeam, 'apps.team'],
      [A.inAdmin, 'apps.admin'],
      [A.rootTeam, 'apps'],
      [A.rootAdmin, 'apps'],
    ];
    for (const [id, p] of placed) {
      await m.withNodeInsertHeads(owner, [{ type: 'app', path: p }], async (tx) => {
        await tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${id}, ${owner}, 'app', ${`${tag} app ${id.slice(0, 6)}`}, ${p}::ltree)`);
        await tx.execute(sqlTag`insert into apps (node_id) values (${id})`);
      });
    }
    for (const id of [A.inTeam, A.rootTeam]) {
      await m.withHeads([id], 'update', async (tx) => {
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id) values (${id}, ${W})`,
        );
      });
    }
  }, 240_000);

  afterAll(async () => {
    hook.trail = false;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('apps are a reader tree kind', () => {
    expect(tree.READER_TREE_KINDS).toContain('apps');
  });

  it('the root: the folder on the way to the team app, and the team app at the root', async () => {
    const page = await asMember(() => tree.loadTreeFolder(owner, 'apps'));
    expect(page?.folders.map((f) => f.id)).toEqual([F.team]);
    expect(page?.items.map((i) => i.id)).toEqual([A.rootTeam]);
  });

  it('the unshared folder opens on the team app; the admin folder does not open', async () => {
    const team = await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.team }));
    expect(team?.items.map((i) => i.id)).toEqual([A.inTeam]);
    expect(await asMember(() => tree.loadTreeFolder(owner, 'apps', { folderId: F.admin }))).toBe(
      null,
    );
  });

  it('the tree lists the same apps as the member’s Apps list', async () => {
    const listed = await asMember(() => appsMod.listApps(owner));
    expect(new Set(listed.map((a) => a.id))).toEqual(new Set([A.inTeam, A.rootTeam]));
  });

  it('the owner sees every folder and app', async () => {
    const root = await tree.loadTreeFolder(owner, 'apps');
    expect(new Set(root?.folders.map((f) => f.id))).toEqual(new Set([F.team, F.admin]));
    expect(new Set(root?.items.map((i) => i.id))).toEqual(new Set([A.rootTeam, A.rootAdmin]));
  });
});
