/**
 * Two creates racing for one file name (W8b). A create stages its bytes
 * beside the final name and places them only once its node insert wins, so
 * the loser's bytes never land under the winner's row: one node, whose
 * sha256 is the bytes on disk, and no staging file left behind. A disk file
 * with no node (an interrupted upload's residue) is still replaced by a
 * create of its name (the self-heal).
 *
 * Fix round 1, on a scratch brain the workspaces migration made live: a
 * create that loses to a row holding its own bytes merges into it (title,
 * data, tags), and makes it private to its login only when the files
 * watcher made it; a create that loses to a row its caller cannot read, or
 * may read but not change, is refused as a taken name (409), the row left
 * as it was.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/files/src/create-race.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('a same-name create race leaves one file, its bytes on disk', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  type Db = typeof import('@mantle/db');
  type Ops = typeof import('./ops');
  type Files = typeof import('./index');
  let m: Db;
  let ops: Ops;
  let f: Files;
  let sqlTag: typeof import('drizzle-orm').sql;
  let root: string;
  let prevRoot: string | undefined;
  const owner = randomUUID();
  const mem = randomUUID(); // a member: Moderator of Edit, a plain user of Read
  const tag = `race-test-${owner.slice(0, 8)}`;
  const top = `files.${tag.replace(/-/g, '_')}`;
  const editWs = randomUUID(); // the folder's home: the member may create there
  const readWs = randomUUID(); // the member reads its items, never changes them
  let adminWs = '';
  let topId = '';

  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
  const dir = () => path.dirname(f.diskPathForFile(top, 'x.txt')!);
  const staging = async () =>
    (await readdir(dir()).catch(() => [] as string[])).filter((n) => n.endsWith('.staged.tmp'));
  const rowsNamed = async (name: string) =>
    (await m.db.execute(sqlTag`
      select id::text as id, data->>'sha256' as sha from nodes
       where owner_id = ${owner} and type = 'file' and path = ${top}::ltree and slug = ${name}`)) as unknown as {
      id: string;
      sha: string;
    }[];
  const onDisk = async (name: string) => readFile(f.diskPathForFile(top, name)!);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rowOf = async (id: string) =>
    (
      (await m.systemDb.execute(sqlTag`
        select title, tags, data, login_id::text as login, home_ws::text as home
          from nodes where id = ${id}`)) as unknown as {
        title: string;
        tags: string[];
        data: Record<string, unknown>;
        login: string | null;
        home: string | null;
      }[]
    )[0]!;
  /** Run `fn` as the member, in a write request's scope (as its routes do). */
  const asMember = async <T>(fn: () => Promise<T>): Promise<T> => {
    const scope = await m.loginScopeFor(mem);
    return m.runInRequestSlot(async () => {
      m.enterRequestScope(scope, { writes: true, drafts: false });
      return fn();
    });
  };
  /**
   * Another create's insert of `name` holding `winner`, held open while
   * `loser` stages its bytes and reaches its own insert (which waits on this
   * row); the winner's bytes go into place before it commits, as upsertFile
   * does. `createWs` homes the winner there (a create that chose a
   * workspace); without it the database homes it in its folder's home, as it
   * does the files watcher's insert.
   */
  const raceAgainst = async (
    name: string,
    winner: Buffer,
    loser: () => Promise<unknown>,
    opts: { createWs?: string } = {},
  ): Promise<{ id: string; failure: unknown }> => {
    const id = randomUUID();
    let failure: unknown;
    let run: Promise<unknown> | undefined;
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`select mantle_lock_heads(${`{${topId}}`}::uuid[], 'share')`);
      if (opts.createWs) {
        await tx.execute(sqlTag`select set_config('mantle.create_ws', ${opts.createWs}, true)`);
      }
      await tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, slug, path, data, tags)
        values (${id}, ${owner}, 'file', ${name}, ${name}, ${top}::ltree, ${JSON.stringify({
          filename: name,
          sha256: sha(winner),
          size_bytes: winner.byteLength,
        })}::jsonb, '{file}')`);
      run = loser().catch((e: unknown) => {
        failure = e;
      });
      for (let i = 0; i < 200 && (await staging()).length === 0; i++) await sleep(25);
      // Staged beside the name, not on it.
      expect(await staging()).toHaveLength(1);
      await writeFile(f.diskPathForFile(top, name)!, winner);
      await sleep(200);
    });
    await run;
    return { id, failure };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    prevRoot = process.env.MANTLE_FILES_ROOT;
    root = await mkdtemp(path.join(tmpdir(), 'mantle-race-'));
    process.env.MANTLE_FILES_ROOT = root;
    m = await import('@mantle/db');
    ops = await import('./ops');
    f = await import('./index');
    sqlTag = (await import('drizzle-orm')).sql;
    const x = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
    await x(sqlTag`
      insert into auth.users (id, email, password_hash, is_owner, role) values
        (${owner}, ${`${tag}@example.invalid`}, 'x', true, 'admin'),
        (${mem}, ${`${tag}-mem@example.invalid`}, 'x', false, 'member')`);
    await x(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      (await x(sqlTag`select id::text as id from workspaces
                       where owner_id = ${owner} and is_admin`)) as unknown as { id: string }[]
    )[0]!.id;
    await x(sqlTag`insert into workspaces (id, owner_id, name) values
      (${editWs}, ${owner}, 'Edit'), (${readWs}, ${owner}, 'Read')`);
    await x(sqlTag`insert into workspace_users (workspace_id, login_id, moderator) values
      (${editWs}, ${mem}, true), (${readWs}, ${mem}, false)`);
    await x(sqlTag`
      insert into nodes (owner_id, type, title, slug, path) values
        (${owner}, 'branch', 'files', 'files', 'files')
      on conflict do nothing`);
    topId = (
      (await x(sqlTag`
        insert into nodes (owner_id, type, title, slug, path) values
          (${owner}, 'branch', ${tag}, ${tag}, ${top}::ltree)
        returning id::text as id`)) as unknown as { id: string }[]
    )[0]!.id;
    // The folder lives in Edit: the member creates there, and a file the
    // database homes by its folder lands there.
    await m.withSubtreeHeads(topId, [], async (tx) => {
      await tx.execute(sqlTag`delete from item_grants where node_id = ${topId}`);
      await tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, is_home)
                              values (${topId}, ${editWs}, true)`);
    });
    await mkdir(dir(), { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
    else process.env.MANTLE_FILES_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('concurrent uploads of one name: one node, its sha256 the bytes on disk, no staging file', async () => {
    for (let round = 0; round < 5; round++) {
      const name = `same-${round}.bin`;
      const bodies = Array.from({ length: 6 }, (_, i) => Buffer.from(`round ${round} upload ${i}`));
      const results = await Promise.allSettled(
        bodies.map((bytes) =>
          ops.upsertFile({ ownerId: owner, parentPath: top, filename: name, bytes }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length, `round ${round}`).toBeGreaterThanOrEqual(1);
      const rows = await rowsNamed(name);
      expect(rows).toHaveLength(1);
      const disk = await onDisk(name);
      expect(rows[0]!.sha).toBe(sha(disk));
      expect(bodies.map((b) => sha(b))).toContain(rows[0]!.sha);
      // Every create that did not land was refused as a taken name.
      for (const r of results) {
        if (r.status === 'rejected') expect(String(r.reason)).toMatch(/already exists/);
      }
      expect(await staging()).toEqual([]);
    }
  });

  it('concurrent spooled uploads of one name: the same', async () => {
    const name = 'spooled-same.bin';
    const bodies = Array.from({ length: 5 }, (_, i) => Buffer.from(`spooled upload ${i}`));
    const spooled = await Promise.all(
      bodies.map((b) => f.spoolUpload(Readable.from([b]), { maxBytes: 1024 })),
    );
    await Promise.allSettled(
      spooled.map((s) =>
        ops.upsertFile({ ownerId: owner, parentPath: top, filename: name, spooled: s }),
      ),
    );
    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toBe(sha(await onDisk(name)));
    expect(await staging()).toEqual([]);
    // No spool file left either: each was placed or dropped.
    const spool = await readdir(f.spoolDir()).catch(() => [] as string[]);
    expect(spool.filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('the create that loses the insert is refused and its bytes never reach the name', async () => {
    const name = 'forced-race.txt';
    const winner = Buffer.from('WINNER');
    let failure: unknown;
    let upsert: Promise<unknown> | undefined;
    // Another create's insert, held open while this create stages its bytes
    // and reaches its own insert (which waits on this row). The winner puts
    // its bytes in place before it commits, as upsertFile does.
    await m.systemDb.transaction(async (tx) => {
      await tx.execute(sqlTag`insert into nodes (owner_id, type, title, slug, path, data, tags)
        values (${owner}, 'file', ${name}, ${name}, ${top}::ltree, ${JSON.stringify({
          filename: name,
          sha256: sha(winner),
          size_bytes: winner.byteLength,
        })}::jsonb, '{file}')`);
      upsert = ops
        .upsertFile({
          ownerId: owner,
          parentPath: top,
          filename: name,
          bytes: Buffer.from('LOSER'),
        })
        .catch((e: unknown) => {
          failure = e;
        });
      for (let i = 0; i < 200 && (await staging()).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Staged beside the name, not on it.
      expect(await staging()).toHaveLength(1);
      await expect(onDisk(name)).rejects.toThrow();
      await writeFile(f.diskPathForFile(top, name)!, winner);
      await new Promise((r) => setTimeout(r, 200));
    });
    await upsert;
    expect(failure).toBeInstanceOf(ops.FileNameTakenError);
    const rows = await rowsNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toBe(sha(winner));
    expect((await onDisk(name)).toString()).toBe('WINNER');
    expect(await staging()).toEqual([]);
  });

  it('an orphan disk file with no node is replaced by a create of its name', async () => {
    const name = 'orphan.txt';
    await writeFile(f.diskPathForFile(top, name)!, 'stale residue');
    const made = await ops.upsertFile({
      ownerId: owner,
      parentPath: top,
      filename: name,
      bytes: Buffer.from('fresh upload'),
    });
    const rows = await rowsNamed(name);
    expect(rows.map((r) => r.id)).toEqual([made.id]);
    expect((await onDisk(name)).toString()).toBe('fresh upload');
    expect(rows[0]!.sha).toBe(sha('fresh upload'));
    expect(await staging()).toEqual([]);

    // The same for a spooled upload.
    const spooledName = 'orphan-spooled.txt';
    await writeFile(f.diskPathForFile(top, spooledName)!, 'stale residue');
    const s = await f.spoolUpload(Readable.from([Buffer.from('fresh spooled')]), {
      maxBytes: 1024,
    });
    await ops.upsertFile({ ownerId: owner, parentPath: top, filename: spooledName, spooled: s });
    expect((await onDisk(spooledName)).toString()).toBe('fresh spooled');
    expect((await rowsNamed(spooledName))[0]!.sha).toBe(sha('fresh spooled'));
    expect(await staging()).toEqual([]);
  });

  it('a create that loses to a row holding its own bytes merges into it', async () => {
    const name = 'same-bytes.txt';
    const bytes = Buffer.from('ONE BODY');
    let made: { id: string } | undefined;
    const { id, failure } = await raceAgainst(name, bytes, async () => {
      made = await ops.upsertFile({
        ownerId: owner,
        parentPath: top,
        filename: name,
        bytes,
        title: 'Merged title',
        tags: ['merged'],
        data: { provenance: 'race-test' },
        loginId: mem,
      });
    });
    expect(failure).toBeUndefined();
    // One row, the one it lost to, carrying this create's title, tags, data.
    expect(made?.id).toBe(id);
    const rows = await rowsNamed(name);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0]!.sha).toBe(sha(bytes));
    const row = await rowOf(id);
    expect(row.title).toBe('Merged title');
    expect(row.tags).toEqual(expect.arrayContaining(['file', 'merged']));
    expect(row.data.provenance).toBe('race-test');
    // The row the database homed by its folder, as the watcher's: it takes
    // the create's login.
    expect(row.home).toBe(editWs);
    expect(row.login).toBe(mem);
    expect((await onDisk(name)).toString()).toBe('ONE BODY');
    expect(await staging()).toEqual([]);
  });

  it("a same-bytes merge never makes another create's row private to its login", async () => {
    const name = 'same-bytes-chosen.txt';
    const bytes = Buffer.from('CHOSEN BODY');
    // The winner chose a workspace: another create's item, not the watcher's.
    const { id, failure } = await raceAgainst(
      name,
      bytes,
      () =>
        ops.upsertFile({
          ownerId: owner,
          parentPath: top,
          filename: name,
          bytes,
          title: 'Retitled',
          loginId: mem,
        }),
      { createWs: readWs },
    );
    expect(failure).toBeUndefined();
    const row = await rowOf(id);
    expect(row.home).toBe(readWs);
    // The system may change it, so the title lands; the login does not.
    expect(row.title).toBe('Retitled');
    expect(row.login).toBeNull();
    expect(await staging()).toEqual([]);
  });

  it('a same-bytes loser cannot retitle or privatise a file its caller may read but not change', async () => {
    const name = 'same-bytes-readonly.txt';
    const bytes = Buffer.from('READ ONLY BODY');
    const { id, failure } = await raceAgainst(
      name,
      bytes,
      () =>
        asMember(() =>
          ops.upsertFile({
            ownerId: owner,
            parentPath: top,
            filename: name,
            bytes,
            title: 'Hijacked',
            tags: ['hijack'],
            loginId: mem,
          }),
        ),
      { createWs: readWs },
    );
    expect(failure).toBeInstanceOf(ops.FileNameTakenError);
    const row = await rowOf(id);
    expect(row.home).toBe(readWs);
    expect(row.title).toBe(name);
    expect(row.tags).not.toContain('hijack');
    expect(row.login).toBeNull();
    expect((await onDisk(name)).toString()).toBe('READ ONLY BODY');
    expect(await staging()).toEqual([]);
  });

  it('a loser whose winning row its caller cannot read is refused as a taken name', async () => {
    const name = 'unseen-winner.txt';
    const winner = Buffer.from('ADMIN ONLY');
    // Homed in Admin: the member does not read it.
    const { id, failure } = await raceAgainst(
      name,
      winner,
      () =>
        asMember(() =>
          ops.upsertFile({
            ownerId: owner,
            parentPath: top,
            filename: name,
            bytes: Buffer.from('MEMBER BYTES'),
          }),
        ),
      { createWs: adminWs },
    );
    expect(failure).toBeInstanceOf(ops.FileNameTakenError);
    expect((await rowOf(id)).home).toBe(adminWs);
    expect((await rowsNamed(name)).map((r) => r.id)).toEqual([id]);
    expect((await onDisk(name)).toString()).toBe('ADMIN ONLY');
    expect(await staging()).toEqual([]);
    // The same with its own bytes: still not the member's to see.
    const same = 'unseen-same.txt';
    const body = Buffer.from('SAME BUT UNSEEN');
    const r2 = await raceAgainst(
      same,
      body,
      () =>
        asMember(() =>
          ops.upsertFile({ ownerId: owner, parentPath: top, filename: same, bytes: body }),
        ),
      { createWs: adminWs },
    );
    expect(r2.failure).toBeInstanceOf(ops.FileNameTakenError);
    expect((await rowOf(r2.id)).title).toBe(same);
  });
});
