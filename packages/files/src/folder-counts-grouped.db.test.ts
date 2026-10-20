/**
 * The Files tree rail and the Files list count every folder's subfolders and
 * files in a fixed number of grouped queries, not two queries per folder.
 * On a migrated scratch brain on workspaces, with a mixed tree that a member
 * reads only part of:
 *
 *  - listAllFolders and listFolders answer exactly what the old per-folder
 *    path (folderCounts, once per folder) answered, for the owner and for the
 *    member, row for row and in the same order: a folder or file the reader
 *    does not read is in no count;
 *  - the member's rail (listAllFoldersWithTrail) lists the folders it reads
 *    as before and the folders on the way to what it reads, each counted as
 *    folderCounts counts it for that reader;
 *  - the number of statements does not grow with the number of folders: two
 *    for the rail, two for a list, one for a list with no folders in it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/folder-counts-grouped.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** `statements`: the statements sent through `db` (each access of a
 *  statement-sending property). `trail`: treat the member's scope as a
 *  session of its login, so the rail asks the trail definer (in the app a
 *  cookie or bearer session decides that, which a package test has none of). */
const hook = vi.hoisted(() => ({ statements: 0, trail: false }));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  const { sql } = await import('drizzle-orm');
  const SENDS = new Set<PropertyKey>(['select', 'selectDistinct', 'execute', 'query']);
  const db = new Proxy(orig.db, {
    get(target, prop) {
      if (SENDS.has(prop)) hook.statements++;
      return Reflect.get(target, prop);
    },
  });
  return {
    ...orig,
    db,
    trailForCaller: (ownerId: string) => (hook.trail ? true : orig.trailForCaller(ownerId)),
    folderTrail: async (ownerId: string, ask: Parameters<typeof orig.folderTrail>[1]) => {
      if (!hook.trail) return orig.folderTrail(ownerId, ask);
      return (await orig.db.execute(
        sql`select t.id::text as id, t.path::text as path, t.title
              from "public"."mantle_folder_trail"(${ownerId}::uuid, ${ask.under ?? null}::text,
                                                  ${orig.textArraySql(ask.paths ?? [])},
                                                  ${ask.folder ?? null}::uuid) t`,
      )) as unknown as Awaited<ReturnType<typeof orig.folderTrail>>;
    },
  };
});

describe.skipIf(!URL)('folder counts in grouped queries (the Files rail and list)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ops: typeof import('./ops');
  let shared: typeof import('./ops/shared');
  let sqlTag: typeof import('drizzle-orm').sql;
  let d: typeof import('drizzle-orm');
  let root = '';
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const member = randomUUID();
  const other = randomUUID();
  const W = randomUUID();
  const tag = `fc${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  // The tree. a: granted to the member's workspace (its subtree with it),
  // holding a file private to another login (a.y) and a subfolder private
  // to it (a.q), so a folder the member reads has a subfolder it does not;
  // b and b.z: not read, but b.z holds a file granted to the workspace (the
  // way to it is a trail); c and c.w: not read at all; files at the root
  // that nobody granted.
  const folders = ['a', 'a.q', 'a.x', 'a.y', 'b', 'b.z', 'c', 'c.w', 'c.w.v'] as const;
  /** Folders private to the other login. */
  const privateFolders = new Set<string>(['a.q']);
  const id: Record<string, string> = Object.fromEntries(
    [...folders, 'files'].map((k) => [k, randomUUID()]),
  );
  const fp = (k: string) => (k === 'files' ? 'files' : `files.${k}`);
  // [folder, file name, private to the other login, granted to W]
  const files: [string, string, boolean, boolean][] = [
    ['files', 'r1.txt', false, false],
    ['files', 'r2.txt', false, false],
    ['a', 'a1.txt', false, false],
    ['a', 'a2.txt', false, false],
    ['a', 'a-private.txt', true, false],
    ['a.x', 'x1.txt', false, false],
    ['a.y', 'y-private.txt', true, false],
    ['b.z', 'z1.txt', false, true],
    ['b.z', 'z2.txt', false, false],
    ['c', 'c1.txt', false, false],
    ['c.w.v', 'v1.txt', false, false],
  ];

  const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  /** A node insert with its folder's head held first, as the writers hold it. */
  const ins = (type: 'branch' | 'file', p: string, q: ReturnType<typeof sqlTag>) =>
    m.withNodeInsertHeads(owner, [{ type, path: p }], (tx) => tx.execute(q));
  const asMember = <T>(fn: () => Promise<T>) => m.withViewer({ login: member }, fn);

  /** The old listAllFolders, verbatim: folderCounts once per folder. */
  const oldListAllFolders = async (ownerId: string) => {
    const rows = await m.db
      .select()
      .from(m.nodes)
      .where(
        d.and(
          d.eq(m.nodes.ownerId, ownerId),
          d.eq(m.nodes.type, 'branch'),
          sqlTag`${m.nodes.path} <@ ${'files'}::ltree`,
        ),
      );
    const out: import('./ops/shared').FolderRow[] = [];
    for (const row of rows) {
      const counts = await shared.folderCounts(ownerId, row.path);
      out.push(shared.folderRowFromNode(row, counts.childFolderCount, counts.fileCount));
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  };

  /** The old listFolders, verbatim. */
  const oldListFolders = async (args: { ownerId: string; parentPath: string }) => {
    const rows = await m.db
      .select()
      .from(m.nodes)
      .where(
        d.and(
          d.eq(m.nodes.ownerId, args.ownerId),
          d.eq(m.nodes.type, 'branch'),
          sqlTag`${m.nodes.path} ~ ${`${args.parentPath}.*{1}`}::lquery`,
        ),
      );
    const results: import('./ops/shared').FolderRow[] = [];
    for (const row of rows) {
      const counts = await shared.folderCounts(args.ownerId, row.path);
      results.push(shared.folderRowFromNode(row, counts.childFolderCount, counts.fileCount));
    }
    results.sort((a, b) => a.slug.localeCompare(b.slug));
    return results;
  };

  const PARENTS = ['files', 'files.a', 'files.b', 'files.c', 'files.c.w', '*', 'files.*'];

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-fcount-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    ops = await import('./ops');
    shared = await import('./ops/shared');
    d = await import('drizzle-orm');
    sqlTag = d.sql;
    const su = (q: ReturnType<typeof sqlTag>) => ts.superuserExec(scratch!.url, q);
    await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin', true)`);
    await ts.runWorkspacesSwitch(scratch.url);
    for (const [login, who] of [
      [member, 'm'],
      [other, 'o'],
    ] as const) {
      await x(sqlTag`insert into auth.users (id, email, password_hash, role, is_owner)
        values (${login}, ${`${tag}-${who}@example.invalid`}, 'x', 'member', false)`);
    }
    await su(
      sqlTag`insert into workspaces (id, owner_id, name) values (${W}, ${owner}, ${`${tag} W`})`,
    );
    await su(sqlTag`delete from workspace_users where login_id in (${member}, ${other})`);
    await su(sqlTag`insert into workspace_users (workspace_id, login_id, moderator)
      values (${W}, ${member}, false), (${W}, ${other}, false)`);
    for (const k of ['files', ...folders]) {
      const slug = k.slice(k.lastIndexOf('.') + 1);
      await ins(
        'branch',
        fp(k),
        sqlTag`insert into nodes (id, owner_id, type, title, slug, path, login_id, data)
        values (${id[k]}, ${owner}, 'branch', ${`${tag} ${k}`}, ${slug}, ${fp(k)}::ltree,
                ${privateFolders.has(k) ? other : null}, ${JSON.stringify({ slug })}::jsonb)`,
      );
    }
    const grants: string[] = [id.a!];
    for (const [k, name, priv, granted] of files) {
      const fid = randomUUID();
      await ins(
        'file',
        fp(k),
        sqlTag`insert into nodes (id, owner_id, type, title, slug, path, login_id, data)
        values (${fid}, ${owner}, 'file', ${name}, ${name}, ${fp(k)}::ltree,
                ${priv ? other : null}, ${JSON.stringify({ filename: name })}::jsonb)`,
      );
      if (granted) grants.push(fid);
    }
    for (const g of grants) {
      await m.withHeads([g], 'update', async (tx) => {
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id) values (${g}, ${W})`,
        );
      });
    }
  }, 240_000);

  afterAll(async () => {
    hook.trail = false;
    await m?.closeDb();
    await scratch?.drop();
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('the member reads part of the tree: a and below (not the other login’s folder and files), and z1 (the fixture)', async () => {
    const seen = await asMember(
      async () =>
        (await m.db.execute(
          sqlTag`select path::text as path, type, coalesce(data->>'filename', '') as name
                   from nodes where owner_id = ${owner} and path <@ 'files'::ltree
                  order by 1, 2, 3`,
        )) as unknown as { path: string; type: string; name: string }[],
    );
    expect(seen.map((r) => `${r.path} ${r.type} ${r.name}`.trim())).toEqual([
      'files.a branch',
      'files.a file a1.txt',
      'files.a file a2.txt',
      'files.a.x branch',
      'files.a.x file x1.txt',
      'files.a.y branch',
      'files.b.z file z1.txt',
    ]);
  });

  it('listAllFolders answers what the per-folder path answered, for the owner and the member', async () => {
    const ownerOld = await oldListAllFolders(owner);
    expect(await ops.listAllFolders(owner)).toEqual(ownerOld);
    expect(ownerOld.map((r) => [r.path, r.childFolderCount, r.fileCount])).toEqual([
      ['files', 3, 2],
      ['files.a', 3, 3],
      ['files.a.q', 0, 0],
      ['files.a.x', 0, 1],
      ['files.a.y', 0, 1],
      ['files.b', 1, 0],
      ['files.b.z', 0, 2],
      ['files.c', 1, 1],
      ['files.c.w', 1, 0],
      ['files.c.w.v', 0, 1],
    ]);
    const memberOld = await asMember(() => oldListAllFolders(owner));
    expect(await asMember(() => ops.listAllFolders(owner))).toEqual(memberOld);
    expect(memberOld.map((r) => [r.path, r.childFolderCount, r.fileCount])).toEqual([
      ['files.a', 2, 2],
      ['files.a.x', 0, 1],
      ['files.a.y', 0, 0],
    ]);
  });

  it('listFolders answers what the per-folder path answered, under every parent, for the owner and the member', async () => {
    for (const parentPath of PARENTS) {
      const args = { ownerId: owner, parentPath };
      expect(await ops.listFolders(args)).toEqual(await oldListFolders(args));
      expect(await asMember(() => ops.listFolders(args))).toEqual(
        await asMember(() => oldListFolders(args)),
      );
    }
  });

  it('the member’s rail: the folders it reads as before, the way to z1 as structure, each counted as folderCounts counts it for the member', async () => {
    hook.trail = true;
    try {
      const rail = await asMember(() => ops.listAllFoldersWithTrail(owner));
      const old = await asMember(() => oldListAllFolders(owner));
      expect(rail.map((r) => r.path)).toEqual([
        'files.a',
        'files.a.x',
        'files.a.y',
        'files.b',
        'files.b.z',
      ]);
      expect(rail.filter((r) => r.createdAt !== '')).toEqual(old);
      for (const r of rail) {
        const c = await asMember(() => shared.folderCounts(owner, r.path));
        expect([r.path, r.childFolderCount, r.fileCount]).toEqual([
          r.path,
          c.childFolderCount,
          c.fileCount,
        ]);
      }
    } finally {
      hook.trail = false;
    }
  });

  it('the statements sent do not grow with the number of folders', async () => {
    const count = async (fn: () => Promise<unknown>) => {
      hook.statements = 0;
      await fn();
      return hook.statements;
    };
    const rail = () => ops.listAllFolders(owner);
    const list = () => ops.listFolders({ ownerId: owner, parentPath: 'files' });
    // A folder with no subfolders: the list of them, and no count query.
    const empty = () => ops.listFolders({ ownerId: owner, parentPath: 'files.a.x' });
    const before = { rail: await count(rail), list: await count(list) };
    expect(await count(empty)).toBe(1);
    const oldBefore = await count(() => oldListAllFolders(owner));
    // Forty more folders, and a file in each.
    for (let i = 0; i < 40; i++) {
      const p = `files.more${i}`;
      await ins(
        'branch',
        p,
        sqlTag`insert into nodes (owner_id, type, title, slug, path)
        values (${owner}, 'branch', ${`more${i}`}, ${`more${i}`}, ${p}::ltree)`,
      );
      await ins(
        'file',
        p,
        sqlTag`insert into nodes (owner_id, type, title, slug, path)
        values (${owner}, 'file', ${`m${i}.txt`}, ${`m${i}.txt`}, ${p}::ltree)`,
      );
    }
    expect(await count(rail)).toBe(before.rail);
    expect(await count(list)).toBe(before.list);
    expect(before.rail).toBe(2);
    expect(before.list).toBe(2);
    // The meter counts: the per-folder path sends two more per folder.
    expect(await count(() => oldListAllFolders(owner))).toBe(oldBefore + 80);
    // And the answers still match it.
    expect(await ops.listAllFolders(owner)).toEqual(await oldListAllFolders(owner));
    expect(await ops.listFolders({ ownerId: owner, parentPath: 'files' })).toEqual(
      await oldListFolders({ ownerId: owner, parentPath: 'files' }),
    );
  });
});
