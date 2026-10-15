/**
 * Arch A3b part 2: the files store and the snapshot store (docs/store-brokers.md),
 * on a migrated scratch database with BOTH checks on (the actor check on: a
 * member's write runs on the write role; the edit check on). A member
 * moderates H and only reads R; O it does not read at all.
 *
 * The files store (the disk path IS the row: store-broker.ts flipThenPlace):
 *  - a refused caller changes NOTHING under the files root (bytes, mtime,
 *    the list): an overwrite, a rename, a file move, a folder rename and
 *    move, a delete;
 *  - an allowed caller writes the row and the disk in step;
 *  - a folder move with hidden rows still answers 409 with nothing moved;
 *  - a commit that fails after the rename (a deferred trigger here) puts the
 *    disk back (the database says the row never landed): the old bytes, the
 *    old name, the old folder;
 *  - a crash between the stage and the flip leaves the old bytes live and
 *    the stage for the staged-leftover sweep;
 *  - email and drive bytes go through the files broker (the lint).
 * The snapshot store:
 *  - a refused caller changes nothing (the stage it made goes with the
 *    refusal): a snapshot of an app and of a table, a delete;
 *  - an allowed caller: the row names the staged copy, with its size; a
 *    delete removes the row only and leaves a tombstone, which the sweep
 *    honours a grace period later; never a file a row names;
 *  - a commit that fails keeps its stage (it may have committed): a file no
 *    row and no tombstone names, only reported by the sweep;
 *  - an accepted copy is a new revision; the old one goes by its tombstone;
 *    a backup holds every copy and every history file a dumped row names;
 *  - off (both checks off, as NATREF, Astron and prod): today's results.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a3b2-store-brokers.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** What a root holds: every file, its size, mtime and bytes. */
function stateOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        const sha = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
        out[path.relative(root, p)] = `${st.size}:${st.mtimeMs}:${sha}`;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** The directories under a root (a folder move moves one). */
function dirsOf(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      out.push(path.relative(root, path.join(d, e.name)));
      walk(path.join(d, e.name));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** The state less SQLite's -wal and -shm files, which a READ opens. */
function filesOf(state: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(state).filter(([f]) => !/-(wal|shm)$/.test(f)));
}

describe.skipIf(!URL)('A3b part 2: the files and snapshot stores, both checks on', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let content: typeof import('@mantle/content');
  let tablesMod: typeof import('@mantle/content/tables');
  let appdb: typeof import('@mantle/content/app-broker');
  let snaps: typeof import('@mantle/content/app-snapshots');
  let history: typeof import('@mantle/content/table-snapshots');
  let sweep: typeof import('@mantle/content/store-sweep');
  let storage: typeof import('@mantle/content/table-storage');
  let dir = '';
  let filesRoot = '';
  let tableRoot = '';
  let appRoot = '';
  const owner = randomUUID();
  const mem = randomUUID();
  const tag = `a3c${randomUUID().slice(0, 6)}`;
  let H = '';
  let R = '';
  let O = '';
  const TOP = 'files.a3b2';

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:a3b2', fn) as Promise<T>;
  const inRequest = async <T>(login: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    return m.runAsActor(m.loginActor(login, 'rw'), () =>
      m.runInRequestSlot(async () => {
        expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
        return fn();
      }),
    ) as Promise<T>;
  };
  /** Home `id` in `ws` alone: its own grants go, a folder's inherited ones
   *  are "Removed here" (a3a-folders.db.test.ts). */
  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${id} and via_folder_id is null`,
      );
      await tx.execute(sql`update item_grants set excluded = true, is_home = false, write = false
                           where node_id = ${id} and workspace_id <> ${ws}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, excluded = false, via_folder_id = null`);
    });
  };
  /** A real SQLite file (a workbook copy) at `abs`. */
  const sqliteAt = (abs: string, v: string) => {
    mkdirSync(path.dirname(abs), { recursive: true });
    const d = new DatabaseSync(abs);
    d.exec(`create table t (v text); insert into t values ('${v}')`);
    d.close();
  };
  const failCommits = async (on: boolean) => {
    await x(on ? sql`insert into a3b2_fail values (true)` : sql`delete from a3b2_fail`);
  };
  const errorOf = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p;
      return null;
    } catch (err) {
      return err;
    }
  };
  const setChecks = async (mode: 'on' | 'off') => {
    process.env.MANTLE_ACTOR_CHECK = mode;
    await su(sql`select mantle_set_edit_check(${mode})`);
  };
  const row = async (id: string) =>
    (
      await x<{ p: string; n: string | null; s: string | null }>(
        sql`select path::text as p, data->>'filename' as n, data->>'sha256' as s
              from nodes where id = ${id}`,
      )
    )[0];
  /** A folder under TOP, homed in `ws`. */
  const folder = async (slug: string, ws: string, parent = TOP) => {
    const r = await sys(() => f.createFolder({ ownerId: owner, parentPath: parent, slug }));
    await homeIn(r.id, ws);
    return r;
  };
  /** A binary file (bytes on disk, not cached in the row), homed in `ws`. */
  const file = async (parent: string, name: string, bytes: string, ws: string) => {
    const r = await sys(() =>
      f.upsertFile({
        ownerId: owner,
        parentPath: parent,
        filename: name,
        bytes: Buffer.from(bytes),
      }),
    );
    await homeIn(r.id, ws);
    return r;
  };
  const onDisk = (parent: string, name: string) => {
    const p = f.diskPathForFile(parent, name)!;
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const makeTable = async (name: string, ws: string) => {
    const t = await sys(() =>
      tablesMod.createTable(owner, {
        title: `${tag} ${name}`,
        data: {
          columns: [{ id: 'c1', name: 'Name', type: 'text' as const }],
          rows: [{ id: 'r1', cells: { c1: name } }],
        },
      }),
    );
    await homeIn(t.id, ws);
    return t.id;
  };
  const makeApp = async (name: string, ws: string) => {
    const a = await sys(() => content.createApp(owner, { title: `${tag} ${name}` }));
    await homeIn(a.id, ws);
    await sys(() => appdb.appDbExec(owner, a.id, 'create table t (v text)'));
    await sys(() => appdb.appDbExec(owner, a.id, "insert into t (v) values ('first')"));
    return a.id;
  };
  /** The sweep a grace period on, past the per-run limit. */
  const sweepLater = () =>
    sweep.sweepStores({
      now: Date.now() + m.STORE_TOMBSTONE_GRACE_MS + m.STORE_SWEEP_GRACE_MS,
      allowMany: true,
    });
  const report = (all: Awaited<ReturnType<typeof sweepLater>>, label: string) =>
    all.find((r) => r.label === label)!;

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = mkdtempSync(path.join(tmpdir(), 'a3b2-brokers-'));
    filesRoot = path.join(dir, 'files');
    tableRoot = path.join(dir, 'tables');
    appRoot = path.join(dir, 'apps');
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = tableRoot;
    process.env.APP_DB_DIR = appRoot;
    process.env.FILES_DIR = filesRoot;
    process.env.MANTLE_FILES_ROOT = filesRoot;
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    content = await import('@mantle/content');
    tablesMod = await import('@mantle/content/tables');
    appdb = await import('@mantle/content/app-broker');
    snaps = await import('@mantle/content/app-snapshots');
    history = await import('@mantle/content/table-snapshots');
    sweep = await import('@mantle/content/store-sweep');
    storage = await import('@mantle/content/table-storage');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mem}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    for (const [key, name] of [
      ['H', 'Home'],
      ['R', 'Reads'],
      ['O', 'Other'],
    ] as const) {
      const [r] = await x<{ id: string }>(sql`
        insert into workspaces (owner_id, name) values (${owner}, ${`${tag} ${name}`})
        returning id::text as id`);
      if (key === 'H') H = r!.id;
      else if (key === 'R') R = r!.id;
      else O = r!.id;
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${H}, ${mem}, true), (${R}, ${mem}, false)`);
    await x(sql`delete from workspace_users u using workspaces w
                 where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin and u.login_id = ${mem}`);
    // A commit that fails after the work (this scratch database only): a
    // deferred trigger on the stores' rows, armed by a row in a3b2_fail.
    await su(sql`create table a3b2_fail (on_ boolean)`);
    await su(
      sql.raw(`create function a3b2_fail_commit() returns trigger language plpgsql
        security definer set search_path = public as $$
        begin
          if exists (select 1 from a3b2_fail) then raise exception 'a3b2: the commit fails'; end if;
          return null;
        end $$`),
    );
    for (const t of ['nodes', 'node_snapshots']) {
      await su(
        sql.raw(`create constraint trigger a3b2_fail_commit after insert or update on ${t}
          deferrable initially deferred for each row execute function a3b2_fail_commit()`),
      );
    }
    await sys(() => f.ensureFilesRootBranch(owner));
    const top = await sys(() =>
      f.createFolder({ ownerId: owner, parentPath: 'files', slug: 'a3b2' }),
    );
    await homeIn(top.id, H);
  }, 240_000);

  afterEach(async () => {
    await failCommits(false);
    await setChecks('on');
    m.takeActorMisses();
  });

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    await m?.closeDb();
    await scratch?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe('the files store (flip, then place)', () => {
    it('a caller the database refuses (reads, cannot edit) changes nothing under the files root', async () => {
      const ro = await folder('ro', R);
      const dest = await folder('dest-ro', H);
      const a = await file(ro.path, 'a.bin', 'one', R);
      const sub = await folder('sub', R, ro.path);
      await file(sub.path, 'b.bin', 'two', R);
      const before = stateOf(filesRoot);
      const dirs = dirsOf(filesRoot);
      const writes: [string, () => Promise<unknown>][] = [
        [
          'overwrite',
          () =>
            f.upsertFile({
              ownerId: owner,
              parentPath: ro.path,
              filename: 'a.bin',
              bytes: Buffer.from('member'),
              overwrite: true,
            }),
        ],
        ['rename', () => f.renameFileById({ ownerId: owner, fileId: a.id, newStem: 'renamed' })],
        ['move', () => f.moveFileById({ ownerId: owner, fileId: a.id, destPath: dest.path })],
        [
          'folder rename',
          () => f.renameFolderById({ ownerId: owner, folderId: sub.id, newSlug: 'sub2' }),
        ],
        [
          'folder move',
          () => f.moveFolderById({ ownerId: owner, folderId: sub.id, destParentPath: dest.path }),
        ],
      ];
      for (const [what, write] of writes) {
        const err = await errorOf(inRequest(mem, write));
        expect(err, what).not.toBeNull();
        expect(stateOf(filesRoot), what).toEqual(before);
        expect(dirsOf(filesRoot), what).toEqual(dirs);
      }
      // A delete the database refuses: refused or not found, never the bytes.
      const del = await errorOf(
        inRequest(mem, async () => {
          const r = await f.deleteFileById({ ownerId: owner, fileId: a.id });
          if (!r.ok) throw new Error(r.reason);
        }),
      );
      expect(del).not.toBeNull();
      expect(stateOf(filesRoot)).toEqual(before);
      expect(await row(a.id)).toMatchObject({ p: ro.path, n: 'a.bin' });
    });

    it('an allowed caller writes the row and the disk in step: an overwrite, a rename, a move, a folder rename and move', async () => {
      const team = await folder('team', H);
      const dest = await folder('dest', H);
      const a = await file(team.path, 'a.bin', 'one', H);
      const over = await inRequest(mem, () =>
        f.upsertFile({
          ownerId: owner,
          parentPath: team.path,
          filename: 'a.bin',
          bytes: Buffer.from('two'),
          overwrite: true,
        }),
      );
      expect(over.id).toBe(a.id);
      expect(onDisk(team.path, 'a.bin')).toBe('two');
      expect((await row(a.id))!.s).toBe(createHash('sha256').update('two').digest('hex'));
      // No staging file and no kept old bytes are left behind.
      expect(readdirSync(path.dirname(f.diskPathForFile(team.path, 'a.bin')!))).toEqual(['a.bin']);
      await inRequest(mem, () => f.renameFileById({ ownerId: owner, fileId: a.id, newStem: 'b' }));
      expect(onDisk(team.path, 'b.bin')).toBe('two');
      expect(onDisk(team.path, 'a.bin')).toBeNull();
      expect((await row(a.id))!.n).toBe('b.bin');
      await inRequest(mem, () =>
        f.moveFileById({ ownerId: owner, fileId: a.id, destPath: dest.path }),
      );
      expect(onDisk(dest.path, 'b.bin')).toBe('two');
      expect((await row(a.id))!.p).toBe(dest.path);
      const renamed = await inRequest(mem, () =>
        f.renameFolderById({ ownerId: owner, folderId: dest.id, newSlug: 'dest-two' }),
      );
      expect(onDisk(renamed!.path, 'b.bin')).toBe('two');
      expect((await row(a.id))!.p).toBe(renamed!.path);
      const moved = await inRequest(mem, () =>
        f.moveFolderById({ ownerId: owner, folderId: dest.id, destParentPath: team.path }),
      );
      expect(onDisk(moved.folder.path, 'b.bin')).toBe('two');
      expect((await row(a.id))!.p).toBe(moved.folder.path);
      expect(existsSync(f.diskPathForLtree(renamed!.path)!)).toBe(false);
    });

    it('a folder move with rows the mover cannot read still answers 409, with nothing moved on disk', async () => {
      const mixed = await folder('mixed', H);
      const dest = await folder('dest-mixed', H);
      await file(mixed.path, 'seen.bin', 'seen', H);
      await file(mixed.path, 'hidden.bin', 'hidden', O);
      const before = stateOf(filesRoot);
      const dirs = dirsOf(filesRoot);
      const err = await errorOf(
        inRequest(mem, () =>
          f.moveFolderById({ ownerId: owner, folderId: mixed.id, destParentPath: dest.path }),
        ),
      );
      // The definer's refusal (42501, detail hidden_rows: a 409 on HTTP).
      expect(m.isHiddenRowsRefusal(err), String(err)).toBe(true);
      expect(stateOf(filesRoot)).toEqual(before);
      expect(dirsOf(filesRoot)).toEqual(dirs);
      expect((await row(mixed.id))!.p).toBe(mixed.path);
    });

    it('a commit that fails after the rename (the database says it never landed) puts the disk back', async () => {
      const quietly = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fail = await folder('fail', H);
      const dest = await folder('dest-fail', H);
      const a = await file(fail.path, 'a.bin', 'old', H);
      const before = stateOf(filesRoot);
      const dirs = dirsOf(filesRoot);
      await failCommits(true);
      const writes: [string, () => Promise<unknown>][] = [
        [
          'overwrite',
          () =>
            f.upsertFile({
              ownerId: owner,
              parentPath: fail.path,
              filename: 'a.bin',
              bytes: Buffer.from('new'),
              overwrite: true,
            }),
        ],
        ['rename', () => f.renameFileById({ ownerId: owner, fileId: a.id, newStem: 'b' })],
        ['move', () => f.moveFileById({ ownerId: owner, fileId: a.id, destPath: dest.path })],
        [
          'folder rename',
          () => f.renameFolderById({ ownerId: owner, folderId: fail.id, newSlug: 'fail-two' }),
        ],
        [
          'folder move',
          () => f.moveFolderById({ ownerId: owner, folderId: fail.id, destParentPath: dest.path }),
        ],
      ];
      for (const [what, write] of writes) {
        const err = await errorOf(inRequest(mem, write));
        expect(String(err), what).toMatch(/the commit fails/);
        expect(stateOf(filesRoot), what).toEqual(before);
        expect(dirsOf(filesRoot), what).toEqual(dirs);
      }
      await failCommits(false);
      expect(onDisk(fail.path, 'a.bin')).toBe('old');
      expect(await row(a.id)).toMatchObject({ p: fail.path, n: 'a.bin' });
      quietly.mockRestore();
    });

    it('a failed overwrite never puts its old bytes over a write that landed after it (fix round 1, M1)', async () => {
      const quietly = vi.spyOn(console, 'error').mockImplementation(() => {});
      const race = await folder('race', H);
      const a = await file(race.path, 'a.bin', 'old', H);
      const finalAbs = f.diskPathForFile(race.path, 'a.bin')!;
      const stageOf = (bytes: string) => {
        const tempPath = path.join(path.dirname(finalAbs), `.${randomUUID()}.staged.tmp`);
        writeFileSync(tempPath, bytes);
        return {
          tempPath,
          finalPath: finalAbs,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        };
      };
      // A places its bytes; its commit fails and the row lets go; B saves and
      // lands before A settles.
      const err = await errorOf(
        m.flipThenPlace({
          ...f.overwriteSteps(a.id, stageOf('A')),
          flip: async (place) => {
            await place();
            await sys(() =>
              f.upsertFile({
                ownerId: owner,
                parentPath: race.path,
                filename: 'a.bin',
                bytes: Buffer.from('B'),
                overwrite: true,
              }),
            );
            throw new Error('the commit fails');
          },
        }),
      );
      expect(String(err)).toMatch(/the commit fails/);
      expect(onDisk(race.path, 'a.bin')).toBe('B');
      expect((await row(a.id))!.s).toBe(createHash('sha256').update('B').digest('hex'));
      // Alone, the same failure puts the old bytes back, with their times.
      const before = stateOf(path.dirname(finalAbs));
      const err2 = await errorOf(
        m.flipThenPlace({
          ...f.overwriteSteps(a.id, stageOf('C')),
          flip: async (place) => {
            await place();
            throw new Error('the commit fails');
          },
        }),
      );
      expect(String(err2)).toMatch(/the commit fails/);
      expect(onDisk(race.path, 'a.bin')).toBe('B');
      expect(stateOf(path.dirname(finalAbs))['a.bin']).toBe(before['a.bin']);
      quietly.mockRestore();
    });

    it('two renames of one file inside an outer transaction that rolls back go back last first (fix round 1, L2)', async () => {
      const outer = await folder('outer', H);
      const a = await file(outer.path, 'a.bin', 'one', H);
      const err = await errorOf(
        sys(() =>
          m.withSystemTx(async () => {
            await f.renameFileById({ ownerId: owner, fileId: a.id, newStem: 'b' });
            await f.renameFileById({ ownerId: owner, fileId: a.id, newStem: 'c' });
            expect(onDisk(outer.path, 'c.bin')).toBe('one');
            throw new Error('the caller failed');
          }),
        ),
      );
      expect(String(err)).toMatch(/the caller failed/);
      expect(onDisk(outer.path, 'a.bin')).toBe('one');
      expect(onDisk(outer.path, 'b.bin')).toBeNull();
      expect(onDisk(outer.path, 'c.bin')).toBeNull();
      expect((await row(a.id))!.n).toBe('a.bin');
    });

    it('a delete inside an outer transaction that rolls back keeps the bytes (fix round 1, L1)', async () => {
      const outer = await folder('outer-del', H);
      const a = await file(outer.path, 'a.bin', 'one', H);
      const err = await errorOf(
        sys(() =>
          m.withSystemTx(async () => {
            expect((await f.deleteFileById({ ownerId: owner, fileId: a.id })).ok).toBe(true);
            throw new Error('the caller failed');
          }),
        ),
      );
      expect(String(err)).toMatch(/the caller failed/);
      expect(onDisk(outer.path, 'a.bin')).toBe('one');
      expect((await row(a.id))!.n).toBe('a.bin');
    });

    it('a delete, then a create of the same name, in one outer transaction: the commit keeps the new bytes (fix round 2, N2)', async () => {
      const again = await folder('again', H);
      const a = await file(again.path, 'a.bin', 'old', H);
      const finalAbs = f.diskPathForFile(again.path, 'a.bin')!;
      await sys(() =>
        m.withSystemTx(async () => {
          expect((await f.deleteFileById({ ownerId: owner, fileId: a.id })).ok).toBe(true);
          // What a create's placing rename does: a new inode under the name.
          const tmp = path.join(path.dirname(finalAbs), `.${randomUUID()}.staged.tmp`);
          writeFileSync(tmp, 'new');
          renameSync(tmp, finalAbs);
        }),
      );
      expect(onDisk(again.path, 'a.bin')).toBe('new');
      // A folder: deleted, made again with a file in it, in one transaction.
      const sub = await folder('again-sub', H, again.path);
      let madePath = '';
      await sys(() =>
        m.withSystemTx(async () => {
          expect(await f.deleteFolder({ ownerId: owner, folderId: sub.id })).toEqual({ ok: true });
          const made = await f.createFolder({
            ownerId: owner,
            parentPath: again.path,
            slug: 'again-sub',
          });
          madePath = made.path;
          writeFileSync(path.join(f.diskPathForLtree(made.path)!, 'kept.txt'), 'inside');
        }),
      );
      expect(readFileSync(path.join(f.diskPathForLtree(madePath)!, 'kept.txt'), 'utf8')).toBe(
        'inside',
      );
      // Rolled back: the deleted folder's directory comes back.
      const gone = await folder('again-gone', H, again.path);
      const goneDir = f.diskPathForLtree(gone.path)!;
      const err = await errorOf(
        sys(() =>
          m.withSystemTx(async () => {
            expect(await f.deleteFolder({ ownerId: owner, folderId: gone.id })).toEqual({
              ok: true,
            });
            expect(existsSync(goneDir)).toBe(false);
            throw new Error('the caller failed');
          }),
        ),
      );
      expect(String(err)).toMatch(/the caller failed/);
      expect(existsSync(goneDir)).toBe(true);
      expect(readdirSync(path.dirname(goneDir)).filter((n) => n.includes('.kept-'))).toEqual([]);
    });

    it("an overwrite's put-back inside a failing savepoint of a login's open write transaction never hangs (fix round 2, N3)", async () => {
      const quietly = vi.spyOn(console, 'error').mockImplementation(() => {});
      const nest = await folder('nest', H);
      const a = await file(nest.path, 'a.bin', 'old', H);
      const finalAbs = f.diskPathForFile(nest.path, 'a.bin')!;
      const stageOf = (bytes: string) => {
        const tempPath = path.join(path.dirname(finalAbs), `.${randomUUID()}.staged.tmp`);
        writeFileSync(tempPath, bytes);
        return {
          tempPath,
          finalPath: finalAbs,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        };
      };
      const failingFlip = (place: () => Promise<void>) =>
        m.db.transaction(() =>
          m.inFlipTransaction(async () => {
            await place();
            throw new Error('the savepoint fails');
          }),
        );
      for (const holdsRow of [false, true]) {
        const started = Date.now();
        await inRequest(mem, () =>
          m.db.transaction(async (tx) => {
            // The open transaction holds the row's lock first: the put-back's
            // lock waits 2 s at most, then the bytes-only branch.
            if (holdsRow) {
              await tx.execute(sql`update nodes set updated_at = now() where id = ${a.id}`);
            }
            const err = await errorOf(
              m.flipThenPlace({ ...f.overwriteSteps(a.id, stageOf('new')), flip: failingFlip }),
            );
            expect(String(err)).toMatch(/the savepoint fails/);
          }),
        );
        expect(Date.now() - started, `holds the row: ${holdsRow}`).toBeLessThan(10_000);
        expect(onDisk(nest.path, 'a.bin')).toBe('old');
      }
      quietly.mockRestore();
    }, 30_000);

    it('a crash between the stage and the flip: the old bytes stay live, the staged-leftover sweep takes the stage', async () => {
      const crash = await folder('crash', H);
      await file(crash.path, 'a.bin', 'old', H);
      const dirAbs = path.dirname(f.diskPathForFile(crash.path, 'a.bin')!);
      // What stageFile leaves when the process dies before the flip.
      const stage = path.join(dirAbs, `.${randomUUID()}.staged.tmp`);
      writeFileSync(stage, 'new');
      const t = (Date.now() - 2 * f.STAGED_LEFTOVER_MIN_AGE_MS) / 1000;
      utimesSync(stage, t, t);
      expect(onDisk(crash.path, 'a.bin')).toBe('old');
      const r = await f.sweepStagedLeftovers({ root: filesRoot });
      expect(r.removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(stage)).toBe(false);
      expect(onDisk(crash.path, 'a.bin')).toBe('old');
    });

    it("off (both checks off): the refused writes of above give today's result", async () => {
      const ro = await folder('ro-off', R);
      const a = await file(ro.path, 'a.bin', 'one', R);
      await setChecks('off');
      await inRequest(mem, () => f.renameFileById({ ownerId: owner, fileId: a.id, newStem: 'b' }));
      expect(onDisk(ro.path, 'b.bin')).toBe('one');
      expect((await row(a.id))!.n).toBe('b.bin');
    });
  });

  describe('the snapshot store', () => {
    const snapState = () => ({
      apps: filesOf(stateOf(path.join(appRoot, '_snapshots'))),
      tables: filesOf(stateOf(path.join(tableRoot, '_snapshots'))),
    });
    const snapRows = async () =>
      (await x<{ n: number }>(sql`select count(*)::int as n from node_snapshots`))[0]!.n;

    it('a caller the database refuses changes nothing: an app snapshot, a table snapshot, a delete', async () => {
      const app = await makeApp('snap-ro', R);
      const t = await makeTable('snap-ro', R);
      const own = await sys(() => snaps.createAppSnapshot(owner, app, { note: 'owner' }));
      const before = snapState();
      const rows = await snapRows();
      const attempts: [string, () => Promise<unknown>][] = [
        [
          'app snapshot',
          () => snaps.createAppSnapshot(owner, app, { actor: 'member', actorLoginId: mem }),
        ],
        ['table snapshot', () => history.createTableSnapshot(owner, t, { note: 'member' })],
        [
          'delete',
          async () => {
            if (!(await snaps.deleteAppSnapshot(owner, app, own!.id))) throw new Error('none');
          },
        ],
      ];
      for (const [what, attempt] of attempts) {
        const out = await errorOf(
          inRequest(mem, async () => {
            const r = await attempt();
            if (r === null) throw new Error('refused as not found');
          }),
        );
        expect(out, what).not.toBeNull();
        expect(snapState(), what).toEqual(before);
        expect(await snapRows(), what).toBe(rows);
      }
      expect(await x(sql`select 1 from store_tombstones`)).toHaveLength(0);
    });

    it('an allowed caller: the row names the staged copy; a delete leaves a tombstone the sweep honours, never a named file', async () => {
      const app = await makeApp('snap-ok', H);
      const snap = await sys(() => snaps.createAppSnapshot(owner, app, { note: 'kept' }));
      const gone = await sys(() => snaps.createAppSnapshot(owner, app, { note: 'gone' }));
      const [r] = await x<{ p: string; b: number }>(
        sql`select db_path as p, db_bytes::int as b from node_snapshots where id = ${snap!.id}`,
      );
      const keptAbs = path.join(appRoot, r!.p);
      expect(statSync(keptAbs).size).toBe(r!.b);
      const goneAbs = (await snaps.appSnapshotFile(owner, app, gone!.id))!.path;
      expect(await sys(() => snaps.deleteAppSnapshot(owner, app, gone!.id))).toBe(true);
      // The row went; its file stays until the sweep, recorded.
      expect(existsSync(goneAbs)).toBe(true);
      expect(
        await x(sql`select 1 from store_tombstones
                     where store = 'appsnap' and path = ${path.relative(appRoot, goneAbs)}`),
      ).toHaveLength(1);
      // A stray tombstone for a file a row names (a restore brought it back):
      // never removed.
      await x(sql`insert into store_tombstones (store, path, created_at)
                  values ('appsnap', ${r!.p}, now() - interval '3 hours')`);
      // A tombstone two hours old stays (a backup's dump may still name the
      // row: fix round 1, M2); a day on it goes.
      const early = await sweep.sweepStores({
        now: Date.now() + 2 * m.STORE_SWEEP_GRACE_MS,
        allowMany: true,
      });
      expect(report(early, 'appsnap').removed).toEqual([]);
      expect(existsSync(goneAbs)).toBe(true);
      const all = await sweepLater();
      expect(report(all, 'appsnap').removed).toContain(
        path.relative(path.join(appRoot, '_snapshots'), goneAbs),
      );
      expect(existsSync(goneAbs)).toBe(false);
      expect(existsSync(keptAbs)).toBe(true);
      expect(
        await x(sql`select 1 from store_tombstones
                     where store = 'appsnap' and path = ${path.relative(appRoot, goneAbs)}`),
      ).toHaveLength(0);
    });

    it('a commit that fails (it may have committed) keeps its stage: no row, no tombstone, only reported', async () => {
      const quietly = vi.spyOn(console, 'error').mockImplementation(() => {});
      const app = await makeApp('snap-fail', H);
      const before = snapState().apps;
      await failCommits(true);
      const err = await errorOf(sys(() => snaps.createAppSnapshot(owner, app, { note: 'x' })));
      await failCommits(false);
      expect(String(err)).toMatch(/the commit fails/);
      const added = Object.keys(snapState().apps).filter((k) => !(k in before));
      expect(added).toHaveLength(1);
      const all = await sweepLater();
      expect(report(all, 'appsnap').noRow).toContain(added[0]);
      expect(existsSync(path.join(appRoot, '_snapshots', added[0]!))).toBe(true);
      // The operator's leftovers (fix round 1): listed, then removed only by
      // a deliberate run, and only what is still a leftover.
      const listed = await sweep.reportedLeftovers();
      expect(listed).toContainEqual({ label: 'appsnap', rel: added[0] });
      const named = Object.keys(before).find((k) => k.endsWith('.sqlite'))!;
      const wanted = sweep.parseLeftovers(`# reviewed\nappsnap\t${added[0]}\nappsnap\t${named}\n`);
      const later = Date.now() + 2 * m.STORE_SWEEP_GRACE_MS;
      const dry = await sweep.removeLeftovers(wanted, { now: later });
      expect(dry.removed).toEqual([{ label: 'appsnap', rel: added[0] }]);
      expect(dry.skipped).toEqual([{ label: 'appsnap', rel: named, why: 'not a leftover now' }]);
      expect(existsSync(path.join(appRoot, '_snapshots', added[0]!))).toBe(true);
      // Too young without the clock moved on: kept.
      expect((await sweep.removeLeftovers(wanted, { apply: true })).removed).toEqual([]);
      // Never while a restore's hold is on a store (fix round 2, N4).
      writeFileSync(path.join(appRoot, '.store-sweep-hold'), '');
      await expect(sweep.removeLeftovers(wanted, { apply: true, now: later })).rejects.toThrow(
        /hold is on/,
      );
      rmSync(path.join(appRoot, '.store-sweep-hold'));
      // A store whose rows name no file at all (no table snapshot here):
      // every file there would look left over; none is listed or removed.
      const stray = path.join(tableRoot, '_snapshots', 'o', 't', `${randomUUID()}.sqlite`);
      mkdirSync(path.dirname(stray), { recursive: true });
      writeFileSync(stray, 'x');
      const old = (Date.now() - 3 * m.STORE_SWEEP_GRACE_MS) / 1000;
      utimesSync(stray, old, old);
      expect((await sweep.reportedLeftovers()).some((l) => l.label === 'tablesnap')).toBe(false);
      const strayRel = path.relative(path.join(tableRoot, '_snapshots'), stray);
      const none = await sweep.removeLeftovers([{ label: 'tablesnap', rel: strayRel }], {
        apply: true,
        now: later,
      });
      expect(none.removed).toEqual([]);
      expect(existsSync(stray)).toBe(true);
      rmSync(stray);
      await sweep.removeLeftovers(wanted, { apply: true, now: later });
      expect(existsSync(path.join(appRoot, '_snapshots', added[0]!))).toBe(false);
      expect(existsSync(path.join(appRoot, '_snapshots', named))).toBe(true);
      quietly.mockRestore();
    });

    it('an accepted copy is a new revision; the old one goes by its tombstone; a backup holds every copy and every history file a dumped row names', async () => {
      const t = await makeTable('accepted', H);
      const acc = path.join(tableRoot, 'accepted-snapshots');
      mkdirSync(acc, { recursive: true });
      const old = `accepted-snapshots/${t}.r-${m.revisionToken()}.sqlite`;
      sqliteAt(path.join(tableRoot, old), 'old copy');
      await x(sql`insert into accepted_snapshots (node_id, kind, title, table_path)
                  values (${t}, 'table', 'x', ${old})`);
      const next = `accepted-snapshots/${t}.r-${m.revisionToken()}.sqlite`;
      sqliteAt(path.join(tableRoot, next), 'new copy');
      // A history file a dumped row names, deleted after the dump began.
      const app = await makeApp('backup', H);
      const snap = await sys(() => snaps.createAppSnapshot(owner, app, { note: 'dumped' }));
      const snapAbs = (await snaps.appSnapshotFile(owner, app, snap!.id))!.path;
      const dumpStartedAt = Date.now();
      await x(sql`update accepted_snapshots set table_path = ${next} where node_id = ${t}`);
      expect(await sys(() => snaps.deleteAppSnapshot(owner, app, snap!.id))).toBe(true);
      const dest = path.join(dir, 'backup');
      const tb = await storage.snapshotAllTableDatabases(path.join(dest, 'tables'), {
        dumpStartedAt,
      });
      expect(tb.failed).toEqual([]);
      for (const p of [old, next]) expect(existsSync(path.join(dest, 'tables', p)), p).toBe(true);
      const ab = await appdb.snapshotAllAppDatabases(path.join(dest, 'apps'), { dumpStartedAt });
      expect(ab.failed).toEqual([]);
      expect(existsSync(path.join(dest, 'apps', path.relative(appRoot, snapAbs)))).toBe(true);
      // The sweep: the old copy goes (its tombstone), the one the row names stays.
      const all = await sweepLater();
      expect(report(all, 'accepted').removed).toEqual([path.basename(old)]);
      expect(existsSync(path.join(tableRoot, old))).toBe(false);
      expect(existsSync(path.join(tableRoot, next))).toBe(true);
    });

    it("off (both checks off): the refused snapshot of above gives today's result", async () => {
      const app = await makeApp('snap-off', R);
      await setChecks('off');
      const snap = await inRequest(mem, () =>
        snaps.createAppSnapshot(owner, app, { actor: 'member', actorLoginId: mem }),
      );
      expect(snap).not.toBeNull();
      expect(existsSync((await snaps.appSnapshotFile(owner, app, snap!.id))!.path)).toBe(true);
    });
  });
});
