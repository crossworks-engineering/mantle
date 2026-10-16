/**
 * Arch A3b: the store brokers (docs/store-brokers.md), on a migrated scratch
 * database with BOTH checks on (the actor check on: a member's write runs on
 * the write role; the edit check on). A member moderates H and only reads R;
 * O it does not read at all. For each store a broker has:
 *
 *  - a refused caller changes NOTHING on disk: every file under the store's
 *    root keeps its bytes, its mtime, and the list stays the same (the
 *    stage it made goes with the refusal);
 *  - an allowed caller writes the row and the disk in step (plan 20.3: the
 *    row points at the new revision; readers follow the row);
 *  - a crash between stage and flip leaves the old revision live and the
 *    stage for the sweep; a commit that fails (a deferred trigger here)
 *    keeps its stage (it may have committed: the sweep takes it), as one
 *    that committed and then threw does; a table created in an outer
 *    transaction that rolls back leaves no stage;
 *    the sweep removes the old revisions of an item whose row names another
 *    file, never a file whose item has no row nor a draft from before A3b;
 *  - a backup taken while a flip lands holds the revision the dump names;
 *  - an app write whose row a restore moved writes neither file, and a
 *    single statement waits out a seed for about 10 s, then answers busy;
 *  - a restore's hold stops the sweep;
 *  - off (both checks off, as NATREF, Astron and prod): the same writes
 *    give today's results.
 *
 * The docs store has no disk writer at all (the lint, arch-lints.test.ts).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a3b-store-brokers.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** What a store's root holds: every file, its size, mtime and bytes. */
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

/** The state less SQLite's -wal and -shm files, which a READ opens (the
 *  repair test reads the table to repair it). */
function filesOf(state: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(state).filter(([f]) => !/-(wal|shm)$/.test(f)));
}

const DOC = (v: string) => ({
  columns: [{ id: 'c1', name: 'Name', type: 'text' as const }],
  rows: [{ id: 'r1', cells: { c1: v } }],
});

describe.skipIf(!URL)('A3b: the store brokers, both checks on', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let tablesMod: typeof import('@mantle/content/tables');
  let broker: typeof import('@mantle/content/table-broker');
  let appdb: typeof import('@mantle/content/app-broker');
  let content: typeof import('@mantle/content');
  let sweep: typeof import('@mantle/content/store-sweep');
  let storage: typeof import('@mantle/content/table-storage');
  let history: typeof import('@mantle/content/table-snapshots');
  let dir = '';
  let tableRoot = '';
  let appRoot = '';
  const owner = randomUUID();
  const mem = randomUUID();
  const tag = `a3b${randomUUID().slice(0, 6)}`;
  let H = '';
  let R = '';
  let O = '';

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:a3b', fn) as Promise<T>;
  /** `fn` in `login`'s mutating request scope, as the session guard enters
   *  it (no route in between: the app's own checks are the content
   *  functions'). */
  const inRequest = async <T>(login: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    return m.runAsActor(m.loginActor(login, 'rw'), () =>
      m.runInRequestSlot(async () => {
        expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
        return fn();
      }),
    ) as Promise<T>;
  };
  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)`);
    });
  };
  const failCommits = async (on: boolean) => {
    await x(on ? sql`insert into a3b_fail values (true)` : sql`delete from a3b_fail`);
  };
  /** The error `p` rejects with, or null. */
  const errorOf = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p;
      return null;
    } catch (err) {
      return err;
    }
  };
  const writeSeq = async (app: string) =>
    Number(
      (
        await x<{ s: number }>(
          sql`select write_seq as s from app_databases where app_node_id = ${app}`,
        )
      )[0]?.s,
    );
  const makeTable = async (name: string, ws: string) => {
    const t = await sys(() =>
      tablesMod.createTable(owner, { title: `${tag} ${name}`, data: DOC(name) }),
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
  const setChecks = async (mode: 'on' | 'off') => {
    process.env.MANTLE_ACTOR_CHECK = mode;
    await su(sql`select mantle_set_edit_check(${mode})`);
  };

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = mkdtempSync(path.join(tmpdir(), 'a3b-brokers-'));
    tableRoot = path.join(dir, 'tables');
    appRoot = path.join(dir, 'apps');
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = tableRoot;
    process.env.APP_DB_DIR = appRoot;
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    tablesMod = await import('@mantle/content/tables');
    broker = await import('@mantle/content/table-broker');
    appdb = await import('@mantle/content/app-broker');
    content = await import('@mantle/content');
    sweep = await import('@mantle/content/store-sweep');
    storage = await import('@mantle/content/table-storage');
    history = await import('@mantle/content/table-snapshots');
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
      const [row] = await x<{ id: string }>(sql`
        insert into workspaces (owner_id, name) values (${owner}, ${`${tag} ${name}`})
        returning id::text as id`);
      if (key === 'H') H = row!.id;
      else if (key === 'R') R = row!.id;
      else O = row!.id;
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${H}, ${mem}, true), (${R}, ${mem}, false)`);
    await x(sql`delete from workspace_users u using workspaces w
                 where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin and u.login_id = ${mem}`);
    // A commit that fails after the work (this scratch database only): a
    // deferred trigger on the stores' rows, armed by a row in a3b_fail.
    await su(sql`create table a3b_fail (on_ boolean)`);
    await su(
      sql.raw(`create function a3b_fail_commit() returns trigger language plpgsql
        security definer set search_path = public as $$
        begin
          if exists (select 1 from a3b_fail) then raise exception 'a3b: the commit fails'; end if;
          return null;
        end $$`),
    );
    for (const t of ['tables', 'app_databases']) {
      await su(
        sql.raw(`create constraint trigger a3b_fail_commit after update on ${t}
          deferrable initially deferred for each row execute function a3b_fail_commit()`),
      );
    }
    // A restore that flips an app's file between a write's read of the row
    // and its check (this scratch database only): armed by a row in
    // a3b_moved, the next bump of write_seq lands on a row that names
    // another file, as if a restore had flipped it just before.
    await su(sql`create table a3b_moved (app uuid, path text)`);
    await su(
      sql.raw(`create function a3b_move_path() returns trigger language plpgsql
        security definer set search_path = public as $$
        declare p text;
        begin
          select m.path into p from a3b_moved m where m.app = new.app_node_id;
          if p is not null and new.write_seq <> old.write_seq then new.storage_path := p; end if;
          return new;
        end $$`),
    );
    await su(
      sql.raw(`create trigger a3b_move_path before update on app_databases
        for each row execute function a3b_move_path()`),
    );
  }, 240_000);

  afterEach(async () => {
    await failCommits(false);
    m.takeActorMisses();
  });

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    await m?.closeDb();
    await scratch?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Two sweeps a grace period apart, as the nightly worker runs them (past
   *  the per-run limit: this database collects every test's revisions; the
   *  limit is store-broker.test.ts's). */
  const sweepTwice = async () => {
    const now = Date.now() + 2 * m.STORE_SWEEP_GRACE_MS;
    await sweep.sweepStores({ now, allowMany: true });
    return sweep.sweepStores({ now: now + m.STORE_SWEEP_GRACE_MS, allowMany: true });
  };
  const tableRow = async (id: string) =>
    (
      await x<{ p: string | null; d: string | null; r: number }>(
        sql`select storage_path as p, draft_path as d, draft_rev as r from tables where node_id = ${id}`,
      )
    )[0]!;

  describe('tables (the tables broker)', () => {
    it('a caller the database refuses (reads, cannot edit) changes nothing on disk', async () => {
      const t = await makeTable('ro', R);
      // A draft to discard and to replace, the owner's.
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('owner draft')));
      const before = stateOf(tableRoot);
      const row = await tableRow(t);
      const writes: [string, () => Promise<unknown>][] = [
        ['draft save', () => tablesMod.saveTableDraft(owner, t, DOC('member'))],
        [
          'op batch',
          () =>
            tablesMod.applyTableOps(owner, t, [
              { op: 'cell_set', rowId: 'r1', columnId: 'c1', value: 'member' },
            ] as never),
        ],
        ['commit', () => tablesMod.commitTable(owner, t)],
        ['commit a doc', () => tablesMod.commitTable(owner, t, DOC('member'))],
        ['discard', () => tablesMod.discardTableDraft(owner, t)],
      ];
      for (const [what, write] of writes) {
        const err = await errorOf(inRequest(mem, write));
        expect(m.isScopeWriteRefusal(err), `${what}: ${String(err)}`).toBe(true);
        // The stage it made went with the refusal: the very same files
        // (bytes, mtime, list; less the -wal and -shm a READ of the draft
        // opens for its guards, as before A3b).
        expect(filesOf(stateOf(tableRoot)), what).toEqual(filesOf(before));
      }
      expect(await tableRow(t)).toEqual(row);
    });

    it('a caller that does not read the table: no stage, no row', async () => {
      const t = await makeTable('hidden', O);
      const before = stateOf(tableRoot);
      const row = await tableRow(t);
      expect(await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('x')))).toBeNull();
      expect(await inRequest(mem, () => tablesMod.commitTable(owner, t, DOC('x')))).toBeNull();
      // The flip itself, as the member: no row is a refusal (a 404).
      const err = await errorOf(
        inRequest(mem, () => broker.flipTable(t, row.r, { draftData: null })),
      );
      expect(err).toBeInstanceOf(m.StoreRefusedError);
      expect(stateOf(tableRoot)).toEqual(before);
      expect(await tableRow(t)).toEqual(row);
    });

    it('an allowed caller writes the row and the disk in step; readers follow the row', async () => {
      const t = await makeTable('team', H);
      const first = await tableRow(t);
      const saved = await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('mine')));
      expect(saved).toEqual({ ok: true, draftRev: first.r + 1 });
      const afterSave = await tableRow(t);
      expect(afterSave.d).toMatch(/\.r-[0-9a-z]+\.draft\.sqlite$/);
      expect(existsSync(path.join(tableRoot, afterSave.d!))).toBe(true);
      // An op batch on an existing draft: in place (the exception).
      const ops = await inRequest(mem, () =>
        tablesMod.applyTableOps(
          owner,
          t,
          [{ op: 'cell_set', rowId: 'r1', columnId: 'c1', value: 'mine 2' }] as never,
          { ifRev: first.r + 1 },
        ),
      );
      expect(ops).toMatchObject({ ok: true, draftRev: first.r + 2 });
      expect((await tableRow(t)).d).toBe(afterSave.d);
      const stale = await inRequest(mem, () =>
        tablesMod.saveTableDraft(owner, t, DOC('stale'), { ifRev: first.r }),
      );
      expect(stale).toEqual({ ok: false, conflict: true, currentRev: first.r + 2 });
      // A member does not read drafts (below admin): the owner's read.
      const read = await sys(() => tablesMod.getTable(owner, t));
      expect(read?.draft?.rows[0]?.cells.c1).toBe('mine 2');
      const committed = await inRequest(mem, () => tablesMod.commitTable(owner, t));
      expect(committed?.data.rows[0]?.cells.c1).toBe('mine 2');
      const afterCommit = await tableRow(t);
      expect(afterCommit.d).toBeNull();
      expect(afterCommit.p).not.toBe(first.p);
      expect(afterCommit.r).toBe(first.r + 3);
      // A commit with no draft writes nothing and moves no revision.
      expect(await errorOf(inRequest(mem, () => tablesMod.commitTable(owner, t)))).toMatchObject({
        message: expect.stringContaining('no draft'),
      });
      expect((await tableRow(t)).r).toBe(first.r + 3);
      // The sweep: the old published file and the old draft go, the live
      // revision stays.
      const oldPub = path.join(tableRoot, first.p!);
      const oldDraft = path.join(tableRoot, afterSave.d!);
      expect(existsSync(oldPub)).toBe(true);
      await sweepTwice();
      expect(existsSync(oldPub)).toBe(false);
      expect(existsSync(oldDraft)).toBe(false);
      expect(existsSync(path.join(tableRoot, afterCommit.p!))).toBe(true);
    });

    it('a crash between stage and flip: the old revision stays live, the sweep takes the stage', async () => {
      const t = await makeTable('crash', H);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('kept draft')));
      const row = await tableRow(t);
      // The stage of a save that never flipped (a crash).
      const rel = broker.tableRevisionPath(owner, t, true);
      broker.stageDoc(rel, DOC('lost') as never, { nodeId: t, ownerId: owner });
      const staged = path.join(tableRoot, rel);
      expect(existsSync(staged)).toBe(true);
      const read = await sys(() => tablesMod.getTable(owner, t));
      expect(read?.draft?.rows[0]?.cells.c1).toBe('kept draft');
      expect(await tableRow(t)).toEqual(row);
      await sweepTwice();
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(path.join(tableRoot, row.d!))).toBe(true);
      expect(existsSync(path.join(tableRoot, row.p!))).toBe(true);
    });

    it('a commit that fails after the stage (it may have committed): the stage stays for the sweep, the old revision stays live', async () => {
      const t = await makeTable('fail', H);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('kept draft')));
      const before = filesOf(stateOf(tableRoot));
      const row = await tableRow(t);
      await failCommits(true);
      const err = await errorOf(sys(() => tablesMod.saveTableDraft(owner, t, DOC('lost'))));
      expect(String(err)).toMatch(/the commit fails/);
      await failCommits(false);
      // A failed COMMIT is an error that may have committed: the stage is
      // kept (fix round 2, N3), no row names it, and the sweep takes it.
      const added = Object.keys(filesOf(stateOf(tableRoot))).filter((f) => !(f in before));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(new RegExp(`${t}\\.r-[0-9a-z]+\\.draft\\.sqlite$`));
      expect(await tableRow(t)).toEqual(row);
      const read = await sys(() => tablesMod.getTable(owner, t));
      expect(read?.draft?.rows[0]?.cells.c1).toBe('kept draft');
      await sweepTwice();
      expect(existsSync(path.join(tableRoot, added[0]!))).toBe(false);
      expect(existsSync(path.join(tableRoot, row.d!))).toBe(true);
    });

    it('a table created inside an outer transaction that rolls back leaves no stage', async () => {
      const before = filesOf(stateOf(tableRoot));
      // Inside a login's open write transaction (a request's db.transaction).
      const err2 = await errorOf(
        inRequest(owner, () =>
          m.db.transaction(async () => {
            await tablesMod.createTable(owner, { title: `${tag} rolled back 2`, data: DOC('x') });
            throw new Error('the request transaction rolls back');
          }),
        ),
      );
      expect(String(err2)).toMatch(/rolls back/);
      expect(filesOf(stateOf(tableRoot))).toEqual(before);
    });

    it('a flip that committed and then threw (a post-commit throw, a lost COMMIT ack): the stage stays and the row works', async () => {
      const t = await makeTable('h2', H);
      const lostAck = Object.assign(new Error('write CONNECTION_CLOSED'), {
        code: 'CONNECTION_CLOSED',
      });
      for (const [label, thrown] of [
        ['after the commit', new Error('a throw after the commit')],
        ['lost ack', lostAck],
      ] as const) {
        let rel = '';
        const err = await errorOf(
          sys(() =>
            broker.stagedTableWrite(
              t,
              {},
              async (r) => {
                rel = broker.revisionBesideRow(r, owner, t, true);
                return {
                  files: [
                    broker.stageDoc(rel, DOC(label) as never, { nodeId: t, ownerId: owner }).abs,
                  ],
                };
              },
              async (r) => {
                await broker.flipTable(t, r.draftRev, {
                  draftPath: rel,
                  draftUpdatedAt: new Date(),
                });
                throw thrown;
              },
            ),
          ),
        );
        expect(err, label).toBe(thrown);
        expect(existsSync(path.join(tableRoot, rel)), label).toBe(true);
        expect((await tableRow(t)).d, label).toBe(rel);
        const read = await sys(() => tablesMod.getTable(owner, t));
        expect(read?.draft?.rows[0]?.cells.c1, label).toBe(label);
      }
      // And the sweep keeps it: the row names it.
      const live = (await tableRow(t)).d!;
      await sweepTwice();
      expect(existsSync(path.join(tableRoot, live))).toBe(true);
    });

    it('a backup taken while a flip lands holds the revision the dump names: restored, the table opens with it', async () => {
      const t = await makeTable('backup', H);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('the dumped draft')));
      // The Postgres dump runs first: it records this row.
      const dumped = await tableRow(t);
      // A commit lands between the dump and the file archive.
      const committed = await sys(() => tablesMod.commitTable(owner, t));
      expect(committed?.data.rows[0]?.cells.c1).toBe('the dumped draft');
      const now = await tableRow(t);
      expect(now.d).toBeNull();
      const dest = mkdtempSync(path.join(dir, 'table-backup-'));
      const report = await sys(() => storage.snapshotAllTableDatabases(dest));
      expect(report.failed).toEqual([]);
      for (const f of [dumped.p!, dumped.d!, now.p!]) {
        expect(existsSync(path.join(dest, f)), f).toBe(true);
      }
      // Restore: the dump's row, the archive as the store.
      const liveRoot = process.env.TABLE_DB_DIR;
      await x(sql`update tables set storage_path = ${dumped.p}, draft_path = ${dumped.d},
                  draft_rev = ${dumped.r} where node_id = ${t}`);
      process.env.TABLE_DB_DIR = dest;
      try {
        const read = await sys(() => tablesMod.getTable(owner, t));
        expect(read?.draft?.rows[0]?.cells.c1).toBe('the dumped draft');
        expect(read?.data.rows[0]?.cells.c1).toBe('backup');
      } finally {
        process.env.TABLE_DB_DIR = liveRoot;
        await x(sql`update tables set storage_path = ${now.p}, draft_path = ${now.d},
                    draft_rev = ${now.r} where node_id = ${t}`);
      }
    });

    it("a draft restored from history lands in the row's folder; the backup keeps each file in its own folder", async () => {
      const t = await makeTable('folded', H);
      const row = await tableRow(t);
      // A table folded in from a member's space keeps its files there (W6b).
      const folder = `space-${tag}`;
      const folded = `${folder}/${path.basename(row.p!)}`;
      mkdirSync(path.join(tableRoot, folder), { recursive: true });
      copyFileSync(path.join(tableRoot, row.p!), path.join(tableRoot, folded));
      await x(sql`update tables set storage_path = ${folded} where node_id = ${t}`);
      const snap = await sys(() => history.createTableSnapshot(owner, t));
      expect(snap).not.toBeNull();
      const restored = await sys(() => history.restoreTableSnapshot(owner, t, snap!.id));
      expect(restored).not.toBeNull();
      const after = await tableRow(t);
      expect(after.d!.startsWith(`${folder}/`)).toBe(true);
      expect(existsSync(path.join(tableRoot, after.d!))).toBe(true);
      const dest = mkdtempSync(path.join(dir, 'table-backup-'));
      const report = await sys(() => storage.snapshotAllTableDatabases(dest));
      expect(report.failed).toEqual([]);
      expect(existsSync(path.join(dest, after.d!))).toBe(true);
      expect(existsSync(path.join(dest, folded))).toBe(true);
    });

    it('a row naming a draft file that is gone (0283 backfill) is no draft: an op batch makes a new one', async () => {
      const t = await makeTable('gone draft', H);
      const row = await tableRow(t);
      const goneRel = row
        .p!.replace(/\.r-[0-9a-z]+\.sqlite$/, '.draft.sqlite')
        .replace(/[^/]+\.draft\.sqlite$/, `${t}.draft.sqlite`);
      await x(sql`update tables set draft_path = ${goneRel}, draft_updated_at = now()
                  where node_id = ${t}`);
      expect(existsSync(path.join(tableRoot, goneRel))).toBe(false);
      const before = await tableRow(t);
      const read = await sys(() => tablesMod.getTable(owner, t));
      expect(read?.draft ?? null).toBeNull();
      const ops = await sys(() =>
        tablesMod.applyTableOps(owner, t, [
          { op: 'cell_set', rowId: 'r1', columnId: 'c1', value: 'new draft' },
        ] as never),
      );
      expect(ops).toMatchObject({ ok: true, draftRev: before.r + 1 });
      const after = await tableRow(t);
      expect(after.d).toMatch(/\.r-[0-9a-z]+\.draft\.sqlite$/);
      const again = await sys(() => tablesMod.getTable(owner, t));
      expect(again?.draft?.rows[0]?.cells.c1).toBe('new draft');
    });

    it("a deleted table's files go with the delete; the sweep never removes a file whose item has no row, nor a draft from before A3b", async () => {
      const t = await makeTable('deleted', H);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('d1')));
      await sys(() => tablesMod.commitTable(owner, t));
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('d2')));
      const row = await tableRow(t);
      const folder = path.join(tableRoot, path.dirname(row.p!));
      expect(readdirSync(folder).filter((f) => f.startsWith(t)).length).toBeGreaterThan(2);
      expect(await sys(() => tablesMod.deleteTable(owner, t))).toBe(true);
      expect(readdirSync(folder).filter((f) => f.startsWith(t) && f.endsWith('.sqlite'))).toEqual(
        [],
      );
      // An old file of an item long gone (from before A3b, maybe the only
      // copy), and a live table's draft from before A3b.
      const old = Date.now() / 1000 - 3 * 86400;
      const ghost = path.join(folder, `${randomUUID()}.sqlite`);
      copyFileSync(path.join(tableRoot, (await tableRow(await makeTable('src', H))).p!), ghost);
      utimesSync(ghost, old, old);
      const live = await makeTable('legacy draft', H);
      const legacy = path.join(
        tableRoot,
        path.dirname((await tableRow(live)).p!),
        `${live}.draft.sqlite`,
      );
      copyFileSync(ghost, legacy);
      utimesSync(legacy, old, old);
      const reports = await sweepTwice();
      expect(existsSync(ghost)).toBe(true);
      expect(existsSync(legacy)).toBe(true);
      const tablesReport = reports.find((r) => r.store === 'tables')!;
      expect(tablesReport.aborted).toBeNull();
      expect(tablesReport.noRow).toContain(path.relative(tableRoot, ghost));
      expect(tablesReport.legacy).toContain(path.relative(tableRoot, legacy));
    });

    it("a restore's hold holds the store sweep (a done run that says so); nothing removed, nothing marked", async () => {
      const t = await makeTable('held', H);
      const first = await tableRow(t);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('a')));
      await sys(() => tablesMod.commitTable(owner, t));
      const hold = path.join(tableRoot, m.STORE_SWEEP_HOLD_FILE);
      writeFileSync(hold, '');
      const quietly = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const now = Date.now() + 2 * m.STORE_SWEEP_GRACE_MS;
        for (const at of [now, now + m.STORE_SWEEP_GRACE_MS]) {
          const reports = await sweep.sweepStores({ now: at });
          const r = reports.find((x) => x.store === 'tables')!;
          expect(r.aborted).toBeNull();
          expect(r.held).toMatch(/^\d{4}-/);
          expect(r.removed).toEqual([]);
          expect(sweep.summariseStoreSweep(reports)).toMatch(/tables: HELD until/);
        }
        expect(existsSync(path.join(tableRoot, first.p!))).toBe(true);
      } finally {
        quietly.mockRestore();
        rmSync(hold, { force: true });
      }
      // Lifted, the old revision goes as before.
      await sweepTwice();
      expect(existsSync(path.join(tableRoot, first.p!))).toBe(false);
    });

    it('a restore re-points a row at a revision the sweep had marked: a backup during the hold keeps it', async () => {
      const t = await makeTable('restored', H);
      const p0 = (await tableRow(t)).p!;
      await sys(() => tablesMod.commitTable(owner, t, DOC('second')));
      // A real-time sweep marks p0 unreferenced (a sweep marks only files a
      // grace period old: p0 is made older).
      const abs0 = path.join(tableRoot, p0);
      const aged = (Date.now() - 2 * m.STORE_SWEEP_GRACE_MS) / 1000;
      utimesSync(abs0, aged, aged);
      await sweep.sweepStores({ allowMany: true });
      expect(m.markedBefore(tableRoot, Date.now() + 1)(abs0)).toBe(true);
      // The restore: its hold first, then the rows (here: this one) name p0.
      const hold = path.join(tableRoot, m.STORE_SWEEP_HOLD_FILE);
      writeFileSync(hold, '');
      try {
        await x(sql`update tables set storage_path = ${p0} where node_id = ${t}`);
        // A backup: its dump names p0; a commit lands before the archive.
        const dumpStartedAt = Date.now() + 1;
        await sys(() => tablesMod.commitTable(owner, t, DOC('third')));
        expect((await tableRow(t)).p).not.toBe(p0);
        const dest = mkdtempSync(path.join(dir, 'table-backup-'));
        const report = await sys(() => storage.snapshotAllTableDatabases(dest, { dumpStartedAt }));
        expect(report.failed).toEqual([]);
        expect(existsSync(path.join(dest, p0))).toBe(true);
        expect(m.markedBefore(tableRoot, dumpStartedAt)(abs0)).toBe(false);
      } finally {
        rmSync(hold, { force: true });
      }
    });

    it("off (both checks off): the refused write of above gives today's result", async () => {
      const t = await makeTable('off', R);
      const rev = (await tableRow(t)).r;
      await setChecks('off');
      try {
        const saved = await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('off')));
        expect(saved).toEqual({ ok: true, draftRev: rev + 1 });
        const read = await sys(() => tablesMod.getTable(owner, t));
        expect(read?.draft?.rows[0]?.cells.c1).toBe('off');
        const committed = await inRequest(mem, () => tablesMod.commitTable(owner, t));
        expect(committed?.data.rows[0]?.cells.c1).toBe('off');
      } finally {
        await setChecks('on');
      }
    });
  });

  describe('app databases (the app broker)', () => {
    /** Hold an app's registry row lock for `ms`, as a running seed does. */
    const holdRowLock = async (a: string, ms: number) => {
      let locked: () => void = () => {};
      const isLocked = new Promise<void>((r) => (locked = r));
      const hold = m.systemDb.transaction(async (tx) => {
        await tx.execute(sql`select 1 from app_databases where app_node_id = ${a} for update`);
        locked();
        await new Promise((r) => setTimeout(r, ms));
      });
      await isLocked;
      // Not the promise itself: an async function would wait for it.
      return { done: hold };
    };

    it('app writes waiting out a seed never take the write pool: three wait and land, another login write goes through meanwhile', async () => {
      const a = await makeApp('pool', H);
      const t = await makeTable('pool', H);
      const held = await holdRowLock(a, 5000);
      const t0 = Date.now();
      const writes = [1, 2, 3].map((i) =>
        inRequest(mem, () => appdb.appDbExec(owner, a, `insert into t (v) values ('w${i}')`)),
      );
      await new Promise((r) => setTimeout(r, 1000));
      const t1 = Date.now();
      expect(
        await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('meanwhile'))),
      ).toMatchObject({ ok: true });
      const meanwhile = Date.now() - t1;
      await Promise.all(writes);
      await held.done;
      expect(meanwhile).toBeLessThan(1000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4000);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by v'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'w1', 'w2', 'w3']);
    }, 30_000);

    it('a caller the database refuses changes nothing on disk (a statement, a seed, a restore)', async () => {
      const a = await makeApp('ro', R);
      const live = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const snap = path.join(dir, `${a}.snap.sqlite`);
      copyFileSync(live, snap);
      const before = stateOf(appRoot);
      const seq = await writeSeq(a);
      const writes: [string, () => Promise<unknown>][] = [
        ['exec', () => appdb.appDbExec(owner, a, "insert into t (v) values ('member')")],
        ['seed', () => appdb.appDbSeedRows(owner, a, 't', [{ v: 'member' }])],
        ['restore', () => appdb.restoreAppDatabaseFile(owner, a, snap, 0, { drainMs: 0 })],
      ];
      for (const [what, write] of writes) {
        const err = await errorOf(inRequest(mem, write));
        expect(m.isScopeWriteRefusal(err), `${what}: ${String(err)}`).toBe(true);
        expect(stateOf(appRoot), what).toEqual(before);
      }
      expect(await writeSeq(a)).toBe(seq);
      expect(await sys(() => appdb.appDatabasePath(owner, a))).toBe(live);
    });

    it('an allowed caller writes the database and the disk in step', async () => {
      const a = await makeApp('team', H);
      const seq = await writeSeq(a);
      await inRequest(mem, () => appdb.appDbExec(owner, a, "insert into t (v) values ('member')"));
      expect(await writeSeq(a)).toBe(seq + 1);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'member']);
    });

    it('a restore stages a new revision and flips the row; the sweep takes the old file', async () => {
      const a = await makeApp('restore', H);
      const live = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const snap = path.join(dir, `${a}.snap.sqlite`);
      copyFileSync(live, snap);
      await sys(() => appdb.appDbExec(owner, a, "insert into t (v) values ('after the snapshot')"));
      await inRequest(mem, () => appdb.restoreAppDatabaseFile(owner, a, snap, 0, { drainMs: 0 }));
      const next = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      expect(next).not.toBe(live);
      expect(next).toMatch(/\.r-[0-9a-z]+\.sqlite$/);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first']);
      expect(existsSync(live)).toBe(true);
      await sweepTwice();
      expect(existsSync(live)).toBe(false);
      expect(existsSync(next)).toBe(true);
    });

    it('a restore whose commit fails (it may have committed): the stage stays for the sweep, the old file stays live', async () => {
      const a = await makeApp('restore fails', H);
      const live = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const snap = path.join(dir, `${a}.snap.sqlite`);
      copyFileSync(live, snap);
      await sys(() => appdb.appDbExec(owner, a, "insert into t (v) values ('after the snapshot')"));
      const before = filesOf(stateOf(appRoot));
      await failCommits(true);
      const err = await errorOf(
        sys(() => appdb.restoreAppDatabaseFile(owner, a, snap, 0, { drainMs: 0 })),
      );
      expect(String(err)).toMatch(/the commit fails/);
      await failCommits(false);
      const added = Object.keys(filesOf(stateOf(appRoot))).filter((f) => !(f in before));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(new RegExp(`${a}\\.r-[0-9a-z]+\\.sqlite$`));
      expect(await sys(() => appdb.appDatabasePath(owner, a))).toBe(live);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'after the snapshot']);
      await sweepTwice();
      expect(existsSync(path.join(appRoot, added[0]!))).toBe(false);
      expect(existsSync(live)).toBe(true);
    });

    it('a write whose row a restore moved to another file since it read it writes neither file (a statement, a seed, a schema)', async () => {
      const a = await makeApp('moved', H);
      const live = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const other = path.join(path.dirname(live), `${a}.r-moved${tag}.sqlite`);
      copyFileSync(live, other);
      const before = filesOf(stateOf(appRoot));
      const seq = await writeSeq(a);
      await x(sql`insert into a3b_moved values (${a}, ${other})`);
      try {
        const writes: [string, () => Promise<unknown>][] = [
          ['exec', () => appdb.appDbExec(owner, a, "insert into t (v) values ('lost')")],
          ['seed', () => appdb.appDbSeedRows(owner, a, 't', [{ v: 'lost' }])],
          [
            'schema',
            () =>
              appdb.appDbQuery(owner, a, 'select 1', [], {
                schemaSql: 'create table if not exists s (v text)',
                schemaVersion: 7,
              }),
          ],
        ];
        for (const [what, write] of writes) {
          const err = await errorOf(sys(write));
          expect(err, `${what}: ${String(err)}`).toBeInstanceOf(appdb.AppDbRestoringError);
          expect(filesOf(stateOf(appRoot)), what).toEqual(before);
        }
      } finally {
        await x(sql`delete from a3b_moved`);
      }
      // Every check rolled back with its refusal: the revision is where it
      // was, the row still names the live file, which holds what it held.
      expect(await writeSeq(a)).toBe(seq);
      expect(await sys(() => appdb.appDatabasePath(owner, a))).toBe(live);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first']);
      rmSync(other, { force: true });
    });

    it("a single statement waits out a seed's row lock (up to about 10 s), then answers busy; nothing written while it waits", async () => {
      const a = await makeApp('busy', H);
      const holdFor = (ms: number) => holdRowLock(a, ms);
      // Held 5 s: the statement waits it out and lands after the seed.
      const short = await holdFor(5000);
      const t0 = Date.now();
      await sys(() => appdb.appDbExec(owner, a, "insert into t (v) values ('after the seed')"));
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4000);
      await short.done;
      // Held 15 s: past the retry, busy, nothing written.
      const long = await holdFor(15000);
      const t1 = Date.now();
      const err = await errorOf(
        sys(() => appdb.appDbExec(owner, a, "insert into t (v) values ('busy')")),
      );
      const waited = Date.now() - t1;
      await long.done;
      expect(err).toBeInstanceOf(appdb.AppSqlBusyError);
      expect(waited).toBeGreaterThanOrEqual(appdb.APP_DB_CHECK_RETRY_MS - 1000);
      expect(waited).toBeLessThan(appdb.APP_DB_CHECK_RETRY_MS + 4000);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'after the seed']);
    }, 60_000);

    it('a backup taken while a restore lands holds the file the dump names', async () => {
      const a = await makeApp('backup', H);
      const dumped = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const snap = path.join(dir, `${a}.snap.sqlite`);
      copyFileSync(dumped, snap);
      await sys(() => appdb.appDbExec(owner, a, "insert into t (v) values ('after the snapshot')"));
      // The dump names `dumped`; a restore flips the row before the archive.
      await sys(() => appdb.restoreAppDatabaseFile(owner, a, snap, 0, { drainMs: 0 }));
      const now = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      expect(now).not.toBe(dumped);
      const dest = mkdtempSync(path.join(dir, 'app-backup-'));
      const report = await sys(() => appdb.snapshotAllAppDatabases(dest));
      expect(report.failed).toEqual([]);
      const rel = (p: string) => path.relative(appRoot, p);
      for (const f of [dumped, now]) expect(existsSync(path.join(dest, rel(f))), f).toBe(true);
      const restored = new DatabaseSync(path.join(dest, rel(dumped)), { readOnly: true });
      try {
        const vs = restored.prepare('select v from t order by rowid').all() as { v: string }[];
        expect(vs.map((r) => r.v)).toEqual(['first', 'after the snapshot']);
      } finally {
        restored.close();
      }
    });

    it('the sweep never removes an app database whose app has no row (an app deleted long ago, from before A3b)', async () => {
      const a = await makeApp('ghost source', H);
      const live = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const ghost = path.join(path.dirname(live), `${randomUUID()}.sqlite`);
      copyFileSync(live, ghost);
      const old = Date.now() / 1000 - 3 * 86400;
      utimesSync(ghost, old, old);
      const reports = await sweepTwice();
      expect(existsSync(ghost)).toBe(true);
      const r = reports.find((x) => x.store === 'appdb')!;
      expect(r.aborted).toBeNull();
      expect(r.noRow).toContain(path.relative(appRoot, ghost));
    });

    it("off (both checks off): the refused write of above gives today's result", async () => {
      const a = await makeApp('off', R);
      await setChecks('off');
      try {
        await inRequest(mem, () => appdb.appDbExec(owner, a, "insert into t (v) values ('off')"));
      } finally {
        await setChecks('on');
      }
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'off']);
    });
  });

  describe('app builds (the app build broker)', () => {
    const ref = (sha: string) => ({
      storageKey: `attachments/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`,
      sha256: sha,
      builtAt: new Date().toISOString(),
      esbuildVersion: 'test',
      bytes: 1,
      ok: true as const,
    });
    const sha = () => createHash('sha256').update(randomUUID()).digest('hex');
    const buildOf = async (a: string) =>
      (
        await x<{ s: string | null }>(
          sql`select draft_build->>'sha256' as s from apps where node_id = ${a}`,
        )
      )[0]?.s ?? null;

    it('a caller the database refuses (a Write grant, no Moderator: D4): the row never names the stage', async () => {
      const a = await makeApp('build ro', R);
      const before = await buildOf(a);
      const store = vi.fn(async () => {});
      const err = await errorOf(
        inRequest(mem, () => content.setDraftBuild(owner, a, ref(sha()), { store })),
      );
      // F4 fix round 3 (M3): the code's door asks manage before the stage,
      // so a refused build stores nothing (before: the stage ran, then the
      // database refused the flip and no reader was pointed at it).
      expect(err).toMatchObject({ code: '42501', detail: 'no_edit' });
      expect(store).not.toHaveBeenCalled();
      expect(await buildOf(a)).toBe(before);
    });

    it('an allowed caller (a Moderator): stage, then the row points at it', async () => {
      const a = await makeApp('build team', H);
      const s = sha();
      const store = vi.fn(async () => {});
      expect(await inRequest(mem, () => content.setDraftBuild(owner, a, ref(s), { store }))).toBe(
        true,
      );
      expect(store).toHaveBeenCalledTimes(1);
      expect(await buildOf(a)).toBe(s);
    });

    it('off (both checks off): the same refusal, by the code door (F4 fix round 3, M3)', async () => {
      const a = await makeApp('build off', R);
      const before = await buildOf(a);
      const store = vi.fn(async () => {});
      await setChecks('off');
      try {
        // Before: the build recorded (no database check in off).
        const err = await errorOf(
          inRequest(mem, () => content.setDraftBuild(owner, a, ref(sha()), { store })),
        );
        expect(err).toMatchObject({ code: '42501', detail: 'no_edit' });
      } finally {
        await setChecks('on');
      }
      expect(store).not.toHaveBeenCalled();
      expect(await buildOf(a)).toBe(before);
    });
  });
});
