/**
 * Arch A3b: the store brokers (docs/store-brokers.md), on a migrated scratch
 * database with BOTH checks on (the actor check on: a member's write runs on
 * the write role; the edit check on). A member moderates H and only reads R;
 * O it does not read at all. For each store a broker has:
 *
 *  - a refused caller changes NOTHING on disk: every file under the store's
 *    root keeps its bytes, its mtime, and the list stays the same;
 *  - an allowed caller writes the database and the disk in step (the
 *    revision moved, the file written, no journal left);
 *  - repair on read: a commit that fails after the disk write (a deferred
 *    trigger here) leaves the disk ahead; the broker's next access trusts
 *    the database and puts the disk back;
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
  const draftRev = async (id: string) =>
    Number(
      (await x<{ r: number }>(sql`select draft_rev as r from tables where node_id = ${id}`))[0]?.r,
    );
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

  describe('tables (the tables broker)', () => {
    it('a caller the database refuses (reads, cannot edit) changes nothing on disk', async () => {
      const t = await makeTable('ro', R);
      // A draft to discard and to replace, the owner's.
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('owner draft')));
      const before = stateOf(tableRoot);
      const rev = await draftRev(t);
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
        expect(stateOf(tableRoot), what).toEqual(before);
      }
      expect(await draftRev(t)).toBe(rev);
    });

    it('a caller that does not read the table: no row, no disk step at all', async () => {
      const t = await makeTable('hidden', O);
      const before = stateOf(tableRoot);
      const rev = await draftRev(t);
      const ran = vi.fn();
      const out = await inRequest(mem, () => broker.withTableWrite(owner, t, async () => ran()));
      expect(out).toBeNull();
      expect(ran).not.toHaveBeenCalled();
      expect(await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('x')))).toBeNull();
      expect(stateOf(tableRoot)).toEqual(before);
      expect(await draftRev(t)).toBe(rev);
    });

    it('an allowed caller writes the database and the disk in step', async () => {
      const t = await makeTable('team', H);
      const rev = await draftRev(t);
      const saved = await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('mine')));
      expect(saved).toEqual({ ok: true, draftRev: rev + 1 });
      expect(await draftRev(t)).toBe(rev + 1);
      const draft = path.join(tableRoot, owner, `${t}.draft.sqlite`);
      expect(existsSync(draft)).toBe(true);
      const ops = await inRequest(mem, () =>
        tablesMod.applyTableOps(
          owner,
          t,
          [{ op: 'cell_set', rowId: 'r1', columnId: 'c1', value: 'mine 2' }] as never,
          { ifRev: rev + 1 },
        ),
      );
      expect(ops).toMatchObject({ ok: true, draftRev: rev + 2 });
      const stale = await inRequest(mem, () =>
        tablesMod.saveTableDraft(owner, t, DOC('stale'), { ifRev: rev }),
      );
      expect(stale).toEqual({ ok: false, conflict: true, currentRev: rev + 2 });
      expect(await draftRev(t)).toBe(rev + 2);
      const committed = await inRequest(mem, () => tablesMod.commitTable(owner, t));
      expect(committed?.data.rows[0]?.cells.c1).toBe('mine 2');
      expect(existsSync(draft)).toBe(false);
      expect(await draftRev(t)).toBe(rev + 3);
      expect(Object.keys(stateOf(tableRoot)).filter((f) => /\.(broker|pre-)/.test(f))).toEqual([]);
      // A commit with no draft writes nothing and moves no revision.
      expect(await errorOf(inRequest(mem, () => tablesMod.commitTable(owner, t)))).toMatchObject({
        message: expect.stringContaining('no draft'),
      });
      expect(await draftRev(t)).toBe(rev + 3);
    });

    it('repair on read: a commit that fails after the disk write; the next read trusts the database', async () => {
      const t = await makeTable('repair', H);
      await sys(() => tablesMod.saveTableDraft(owner, t, DOC('kept draft')));
      const draft = path.join(tableRoot, owner, `${t}.draft.sqlite`);
      const before = stateOf(tableRoot);
      const rev = await draftRev(t);
      await failCommits(true);
      const err = await errorOf(sys(() => tablesMod.saveTableDraft(owner, t, DOC('lost'))));
      expect(String(err)).toMatch(/the commit fails/);
      await failCommits(false);
      // The disk is ahead: the new draft is there, with its journal.
      expect(stateOf(tableRoot)).not.toEqual(before);
      expect(existsSync(`${path.join(tableRoot, owner, `${t}.sqlite`)}.broker`)).toBe(true);
      expect(await draftRev(t)).toBe(rev);
      // The next read: the database never took it; the disk goes back.
      const read = await sys(() => tablesMod.getTable(owner, t));
      expect(read?.draft?.rows[0]?.cells.c1).toBe('kept draft');
      // The very files of before (bytes, mtime: the pre-image itself), no
      // journal, no pre-image left.
      expect(filesOf(stateOf(tableRoot))).toEqual(filesOf(before));
      expect(existsSync(draft)).toBe(true);
    });

    it("off (both checks off): the refused write of above gives today's result", async () => {
      const t = await makeTable('off', R);
      const rev = await draftRev(t);
      await setChecks('off');
      try {
        const saved = await inRequest(mem, () => tablesMod.saveTableDraft(owner, t, DOC('off')));
        expect(saved).toEqual({ ok: true, draftRev: rev + 1 });
        expect(existsSync(path.join(tableRoot, owner, `${t}.draft.sqlite`))).toBe(true);
        const read = await sys(() => tablesMod.getTable(owner, t));
        expect(read?.draft?.rows[0]?.cells.c1).toBe('off');
      } finally {
        await setChecks('on');
      }
    });
  });

  describe('app databases (the app broker)', () => {
    it('a caller the database refuses changes nothing on disk', async () => {
      const a = await makeApp('ro', R);
      const before = stateOf(appRoot);
      const seq = await writeSeq(a);
      const writes: [string, () => Promise<unknown>][] = [
        ['exec', () => appdb.appDbExec(owner, a, "insert into t (v) values ('member')")],
        ['seed', () => appdb.appDbSeedRows(owner, a, 't', [{ v: 'member' }])],
      ];
      for (const [what, write] of writes) {
        const err = await errorOf(inRequest(mem, write));
        expect(m.isScopeWriteRefusal(err), `${what}: ${String(err)}`).toBe(true);
        expect(stateOf(appRoot), what).toEqual(before);
      }
      expect(await writeSeq(a)).toBe(seq);
    });

    it('an allowed caller writes the database and the disk in step', async () => {
      const a = await makeApp('team', H);
      const seq = await writeSeq(a);
      await inRequest(mem, () => appdb.appDbExec(owner, a, "insert into t (v) values ('member')"));
      expect(await writeSeq(a)).toBe(seq + 1);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'member']);
    });

    it('repair on read: a restore whose commit fails is undone on the next access', async () => {
      const a = await makeApp('repair', H);
      const live = (await sys(() => appdb.appDatabasePath(owner, a)))!;
      const snap = path.join(dir, `${a}.snap.sqlite`);
      copyFileSync(live, snap);
      await sys(() => appdb.appDbExec(owner, a, "insert into t (v) values ('after the snapshot')"));
      const seq = await writeSeq(a);
      await failCommits(true);
      const err = await errorOf(
        sys(() => appdb.restoreAppDatabaseFile(owner, a, snap, 0, { drainMs: 0 })),
      );
      expect(String(err)).toMatch(/the commit fails/);
      await failCommits(false);
      expect(existsSync(`${live}.broker`)).toBe(true);
      expect(await writeSeq(a)).toBe(seq);
      const rows = await sys(() => appdb.appDbQuery(owner, a, 'select v from t order by rowid'));
      expect(rows.map((r) => r.v)).toEqual(['first', 'after the snapshot']);
      expect(existsSync(`${live}.broker`)).toBe(false);
      expect(readdirSync(path.dirname(live)).filter((f) => f.includes('.pre-'))).toEqual([]);
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

    it('a caller the database refuses (a Write grant, no Moderator: D4) stores nothing', async () => {
      const a = await makeApp('build ro', R);
      const store = vi.fn(async () => {});
      const err = await errorOf(
        inRequest(mem, () => content.setDraftBuild(owner, a, ref(sha()), { store })),
      );
      expect(m.isScopeWriteRefusal(err), String(err)).toBe(true);
      expect(store).not.toHaveBeenCalled();
    });

    it('an allowed caller (a Moderator) records the ref and stores the bundle in its transaction', async () => {
      const a = await makeApp('build team', H);
      const s = sha();
      const store = vi.fn(async () => {});
      expect(await inRequest(mem, () => content.setDraftBuild(owner, a, ref(s), { store }))).toBe(
        true,
      );
      expect(store).toHaveBeenCalledTimes(1);
      const [row] = await x<{ s: string }>(
        sql`select draft_build->>'sha256' as s from apps where node_id = ${a}`,
      );
      expect(row?.s).toBe(s);
    });

    it("off (both checks off): today's result", async () => {
      const a = await makeApp('build off', R);
      const store = vi.fn(async () => {});
      await setChecks('off');
      try {
        expect(
          await inRequest(mem, () => content.setDraftBuild(owner, a, ref(sha()), { store })),
        ).toBe(true);
      } finally {
        await setChecks('on');
      }
      expect(store).toHaveBeenCalledTimes(1);
    });
  });
});
