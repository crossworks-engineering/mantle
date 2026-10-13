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
 *    takes its stage with it; the sweep removes what no row points at;
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
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
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
  let dir = '';
  let tableRoot = '';
  let appRoot = '';
  const owner = randomUUID();
  const mem = randomUUID();
  const tag = `a3b${randomUUID().slice(0, 6)}`;
  let H = '';
  let R = '';
  let O = '';

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
    await x(sql`select mantle_set_edit_check(${mode})`);
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
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    tablesMod = await import('@mantle/content/tables');
    broker = await import('@mantle/content/table-broker');
    appdb = await import('@mantle/content/app-broker');
    content = await import('@mantle/content');
    sweep = await import('@mantle/content/store-sweep');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mem}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
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
                 where w.id = u.workspace_id and w.bridge_key = 'team' and u.login_id = ${mem}`);
    // A commit that fails after the work (this scratch database only): a
    // deferred trigger on the stores' rows, armed by a row in a3b_fail.
    await x(sql`create table a3b_fail (on_ boolean)`);
    await x(
      sql.raw(`create function a3b_fail_commit() returns trigger language plpgsql
        security definer set search_path = public as $$
        begin
          if exists (select 1 from a3b_fail) then raise exception 'a3b: the commit fails'; end if;
          return null;
        end $$`),
    );
    for (const t of ['tables', 'app_databases']) {
      await x(
        sql.raw(`create constraint trigger a3b_fail_commit after update on ${t}
          deferrable initially deferred for each row execute function a3b_fail_commit()`),
      );
    }
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

  /** Two sweeps a grace period apart, as the nightly worker runs them. */
  const sweepTwice = async () => {
    const now = Date.now() + 2 * m.STORE_SWEEP_GRACE_MS;
    await sweep.sweepStores({ now });
    return sweep.sweepStores({ now: now + m.STORE_SWEEP_GRACE_MS });
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
      // revision stays, the history copy of the old version stays.
      const oldPub = path.join(tableRoot, first.p!);
      const oldDraft = path.join(tableRoot, afterSave.d!);
      expect(existsSync(oldPub)).toBe(true);
      await sweepTwice();
      expect(existsSync(oldPub)).toBe(false);
      expect(existsSync(oldDraft)).toBe(false);
      expect(existsSync(path.join(tableRoot, afterCommit.p!))).toBe(true);
      expect(
        Object.keys(stateOf(path.join(tableRoot, '_snapshots'))).some((f) => f.includes(t)),
      ).toBe(true);
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

    it('a commit that fails after the stage: the stage goes, the old revision stays live', async () => {
      const t = await makeTable('fail', H);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('kept draft')));
      const before = stateOf(tableRoot);
      const row = await tableRow(t);
      await failCommits(true);
      const err = await errorOf(sys(() => tablesMod.saveTableDraft(owner, t, DOC('lost'))));
      expect(String(err)).toMatch(/the commit fails/);
      await failCommits(false);
      expect(filesOf(stateOf(tableRoot))).toEqual(filesOf(before));
      expect(await tableRow(t)).toEqual(row);
      const read = await sys(() => tablesMod.getTable(owner, t));
      expect(read?.draft?.rows[0]?.cells.c1).toBe('kept draft');
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

    it('a restore whose commit fails: the stage goes, the old file stays live', async () => {
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
      expect(filesOf(stateOf(appRoot))).toEqual(before);
      expect(await sys(() => appdb.appDatabasePath(owner, a))).toBe(live);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'after the snapshot']);
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
      expect(m.isScopeWriteRefusal(err), String(err)).toBe(true);
      // The stage ran before the flip (plan 20.3); no reader is pointed at it.
      expect(store).toHaveBeenCalledTimes(1);
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

    it("off (both checks off): today's result", async () => {
      const a = await makeApp('build off', R);
      const s = sha();
      await setChecks('off');
      try {
        expect(
          await inRequest(mem, () =>
            content.setDraftBuild(owner, a, ref(s), { store: async () => {} }),
          ),
        ).toBe(true);
      } finally {
        await setChecks('on');
      }
      expect(await buildOf(a)).toBe(s);
    });
  });
});
