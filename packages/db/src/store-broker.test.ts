/**
 * The store brokers' one helper (arch A3b, plan 20.3, store-broker.ts), on
 * plain files: the one-row check, stage then flip (a flip known not to have
 * landed takes its stage with it; one that may have committed keeps a stage
 * a row names), and the one sweep (never a live file, never before a grace
 * period, two runs apart, a SQLite file's sidecars with it; never a file
 * whose node has no row or whose row's file is missing, never a legacy
 * draft; a stop on a row outside the root, on no row at all, on too many). The
 * per-store DB tests are server/web/server/a3b-store-brokers.db.test.ts and
 * a3b2-store-brokers.db.test.ts (part 2).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  STORE_SWEEP_HOLD_FILE,
  STORE_SWEEP_HOLD_MS,
  STORE_TOMBSTONE_GRACE_MS,
  StoreRefusedError,
  flipNeverLanded,
  flipRolledBack,
  flipThenPlace,
  inFlipTransaction,
  isLegacyDraftName,
  markedBefore,
  oneRow,
  removeSqliteFile,
  revisionFiles,
  revisionNode,
  revisionTime,
  revisionToken,
  stageThenFlip,
  sweepOrphans,
} from './store-broker';
import { editRefusalDetail, isScopeWriteRefusal } from './pg-error';

const dir = mkdtempSync(path.join(tmpdir(), 'store-broker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the checked statement', () => {
  it('needs exactly one row; none or two is the edit check refusal (a 404 everywhere)', () => {
    for (const rows of [[], [1, 2]]) {
      let err: unknown;
      try {
        oneRow('tables', rows, 'table');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(StoreRefusedError);
      expect(isScopeWriteRefusal(err)).toBe(true);
      expect(editRefusalDetail(err)).toBe('no_read');
    }
    expect(oneRow('tables', [7], 'table')).toBe(7);
  });

  it('revision tokens are unique and sort by time', () => {
    const a = revisionToken();
    const b = revisionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-z]+$/);
  });
});

describe('stageThenFlip', () => {
  const put = (name: string) => {
    const f = path.join(dir, name);
    writeFileSync(f, 'new');
    return f;
  };
  const rm = (s: string) => rmSync(s, { force: true });

  it('a flip that lands keeps the stage', async () => {
    const f = path.join(dir, 'kept');
    const out = await stageThenFlip(
      () => put('kept'),
      async () => 'flipped',
      rm,
    );
    expect(out).toBe('flipped');
    expect(existsSync(f)).toBe(true);
  });

  it('a refused flip removes its stage at once and throws the refusal', async () => {
    let f = '';
    await expect(
      stageThenFlip(
        () => (f = put('refused')),
        async () => oneRow('tables', [], 'table'),
        rm,
      ),
    ).rejects.toBeInstanceOf(StoreRefusedError);
    expect(existsSync(f)).toBe(false);
  });

  it("a throw inside the flip's transaction (rolled back) removes the stage at once", async () => {
    let f = '';
    await expect(
      stageThenFlip(
        () => (f = put('rolled-back')),
        () =>
          inFlipTransaction(async () => {
            throw new Error('a conflict');
          }),
        rm,
      ),
    ).rejects.toThrow('a conflict');
    expect(existsSync(f)).toBe(false);
    expect(flipNeverLanded(flipRolledBack(new Error('x')))).toBe(true);
    expect(flipNeverLanded(new Error('x'))).toBe(false);
  });

  it('a flip that may have committed (a post-commit throw, a lost COMMIT ack, a failed commit) keeps its stage', async () => {
    const quietly = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const err of [
      new Error('after the commit'),
      new Error('write CONNECTION_CLOSED'),
      new Error('the commit fails'),
    ]) {
      let f = '';
      await expect(
        stageThenFlip(
          () => (f = put(`ambiguous-${revisionToken()}`)),
          async () => {
            throw err;
          },
          rm,
        ),
      ).rejects.toBe(err);
      expect(existsSync(f)).toBe(true);
    }
    quietly.mockRestore();
  });
});

describe('flipThenPlace (a store whose disk path is its row: the files tree)', () => {
  /** A file at `from` that a flip renames to `to` as its last step. */
  const setup = (name: string) => {
    const from = path.join(dir, `${name}-old`);
    const to = path.join(dir, `${name}-new`);
    writeFileSync(from, name);
    const steps = {
      place: async () => renameSync(from, to),
      unplace: async () => renameSync(to, from),
    };
    return { from, to, steps };
  };

  it('a refusal (the checked statement first) never touches the disk', async () => {
    const { from, to, steps } = setup('refused');
    await expect(
      flipThenPlace({
        ...steps,
        flip: (place) =>
          inFlipTransaction(async () => {
            oneRow('files', [], 'file');
            await place();
          }),
        settle: async () => true,
      }),
    ).rejects.toBeInstanceOf(StoreRefusedError);
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  it('a flip that lands keeps the disk where place put it; place runs once on a retry', async () => {
    const { from, to, steps } = setup('lands');
    let places = 0;
    const out = await flipThenPlace({
      ...steps,
      place: async () => {
        places += 1;
        await steps.place();
      },
      flip: async (place) => {
        await place();
        await place(); // a retried transaction finds it placed
        return 'ok';
      },
      settle: async () => true,
    });
    expect(out).toBe('ok');
    expect(places).toBe(1);
    expect(existsSync(from)).toBe(false);
    expect(existsSync(to)).toBe(true);
  });

  it('a commit that failed after place: the database says it never landed, the disk goes back', async () => {
    const { from, to, steps } = setup('commit-failed');
    let discarded = false;
    await expect(
      flipThenPlace({
        ...steps,
        discard: async () => {
          discarded = true;
        },
        flip: async (place) => {
          await place();
          throw new Error('the commit fails');
        },
        settle: async () => false,
      }),
    ).rejects.toThrow('the commit fails');
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
    expect(discarded).toBe(true);
  });

  it('a lost COMMIT acknowledgement after place: the database says it landed, the disk stays; unknown: left, logged', async () => {
    const quietly = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = setup('landed');
    let released = false;
    await expect(
      flipThenPlace({
        ...a.steps,
        release: async () => {
          released = true;
        },
        flip: async (place) => {
          await place();
          throw new Error('write CONNECTION_CLOSED');
        },
        settle: async () => true,
      }),
    ).rejects.toThrow('CONNECTION_CLOSED');
    expect(existsSync(a.to)).toBe(true);
    expect(released).toBe(true);
    const b = setup('unknown');
    await expect(
      flipThenPlace({
        ...b.steps,
        flip: async (place) => {
          await place();
          throw new Error('write CONNECTION_CLOSED');
        },
        settle: async () => {
          throw new Error('the database is gone');
        },
      }),
    ).rejects.toThrow('CONNECTION_CLOSED');
    expect(existsSync(b.to)).toBe(true);
    quietly.mockRestore();
  });
});

describe("the stores' file names", () => {
  const node = '0b4f1c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';
  it('one name rule for both stores; a draft for a table only', () => {
    expect(revisionNode(`${node}.sqlite`, 'tables')).toBe(node);
    expect(revisionNode(`${node}.r-abc123.sqlite`, 'appdb')).toBe(node);
    expect(revisionNode(`${node}.r-abc123.draft.sqlite`, 'tables')).toBe(node);
    expect(revisionNode(`${node}.r-abc123.draft.sqlite`, 'appdb')).toBeNull();
    for (const n of [
      `${node}.sqlite-wal`,
      `${node}.sqlite.restoring`,
      'x.sqlite',
      '.store-sweep.json',
    ]) {
      expect(revisionNode(n, 'tables')).toBeNull();
    }
    expect(isLegacyDraftName(`${node}.draft.sqlite`)).toBe(true);
    expect(isLegacyDraftName(`${node}.r-1.draft.sqlite`)).toBe(false);
  });

  it('removeSqliteFile takes every sidecar, -journal too', () => {
    const f = path.join(dir, `${node}.sqlite`);
    for (const x of ['', '-wal', '-shm', '-journal']) writeFileSync(`${f}${x}`, 'x');
    writeFileSync(path.join(dir, `${node}.r-2.sqlite`), 'x');
    expect(revisionFiles(dir, node, 'tables').sort()).toEqual([
      path.join(dir, `${node}.r-2.sqlite`),
      f,
    ]);
    removeSqliteFile(f);
    for (const x of ['', '-wal', '-shm', '-journal']) expect(existsSync(`${f}${x}`)).toBe(false);
  });
});

describe('sweepOrphans', () => {
  const HOUR = 3_600_000;
  let root = path.join(dir, 'store');
  const put = (rel: string, ageMs: number, at = root) => {
    const abs = path.join(at, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, rel);
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(abs, t, t);
    return abs;
  };
  /** `<owner>/<node>[.r-<token>][.draft].sqlite`, one folder deep. */
  const nodeOf = (rel: string) =>
    /^[a-z]+\/([a-z]+)(?:\.r-[0-9a-z]+)?(?:\.draft)?\.sqlite$/.exec(rel)?.[1] ?? null;
  const spec = (rows: { node: string; files: string[] }[], at = root) => ({
    store: 'tables' as const,
    root: at,
    nodeOf,
    spare: (rel: string) => /\/[a-z]+\.draft\.sqlite$/.test(rel),
    rows: async () => rows,
  });
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('a committed draft (its row names the promoted copy, no draft) goes a grace period later, as any old revision', async () => {
    // A commit (commitTable, and so dwg-reindex's rebuild through it) promotes
    // the draft by copy and clears draft_path: the draft file it leaves is an
    // old revision the sweep removes, never a spared legacy draft.
    root = path.join(dir, 'store-draft');
    const published = put('o/d.r-2.sqlite', 3 * HOUR);
    const draft = put('o/d.r-1.draft.sqlite', 3 * HOUR);
    const rows = [{ node: 'd', files: ['o/d.r-2.sqlite'] }];
    const now = Date.now();
    const first = await sweepOrphans(spec(rows), { now });
    expect(first.removed).toEqual([]);
    expect(first.legacy).toEqual([]);
    const later = await sweepOrphans(spec(rows), { now: now + HOUR });
    expect(later.removed).toEqual(['o/d.r-1.draft.sqlite']);
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(published)).toBe(true);
  });

  it('removes an old revision only on a run a grace period after it first saw it', async () => {
    root = path.join(dir, 'store-1');
    const live = put('o/a.r-1.sqlite', 3 * HOUR);
    const old = put('o/a.r-0.sqlite', 3 * HOUR);
    put('o/a.r-0.sqlite-wal', 3 * HOUR);
    const history = put('_snapshots/o/a/x.sqlite', 3 * HOUR);
    const other = put('o/notes.txt', 3 * HOUR);
    const rows = [{ node: 'a', files: ['o/a.r-1.sqlite'] }];
    const now = Date.now();
    const first = await sweepOrphans(spec(rows), { now });
    expect(first.removed).toEqual([]);
    expect(first.marked).toBe(1);
    // Too soon: still kept.
    expect((await sweepOrphans(spec(rows), { now: now + 1000 })).removed).toEqual([]);
    // A stage made just before the next run: still in flight.
    const fresh = put('o/a.r-2.sqlite', -HOUR + 1000);
    // A grace period later: the old revision goes, with its sidecar; the
    // stage is younger than the grace period.
    const later = await sweepOrphans(spec(rows), { now: now + HOUR });
    expect(later.removed).toEqual(['o/a.r-0.sqlite']);
    expect(later.aborted).toBeNull();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}-wal`)).toBe(false);
    for (const kept of [live, fresh, history, other]) expect(existsSync(kept)).toBe(true);
  });

  it('tombstones (A3b part 2): a file whose row went goes a day after the tombstone (by its database age), never while a row names it; neither: reported', async () => {
    root = path.join(dir, 'store-tomb');
    const hold = path.join(dir, 'store-tomb-base');
    mkdirSync(hold, { recursive: true });
    const DAY = STORE_TOMBSTONE_GRACE_MS;
    // A snapshot store: `<owner>/<item>/<id>.sqlite`, the item the row.
    const snapOf = (rel: string) => /^[a-z]+\/[a-z]+\/([a-z]+)\.sqlite$/.exec(rel)?.[1] ?? null;
    const deleted = put('o/app/gone.sqlite', 3 * HOUR);
    put('o/app/gone.sqlite-wal', 3 * HOUR);
    const young = put('o/app/young.sqlite', 3 * HOUR);
    const named = put('o/app/kept.sqlite', 3 * HOUR);
    const unknown = put('o/app/mystery.sqlite', 3 * HOUR);
    let tombs = [
      { abs: deleted, ageMs: DAY + HOUR },
      // A tombstone an hour old (past the file grace, not past a day): a
      // backup's dump may still name its row (fix round 1, M2).
      { abs: young, ageMs: 2 * HOUR },
      // A tombstone for a file a row names again (a restore): never.
      { abs: named, ageMs: 5 * DAY },
      // One outside the root never lets anything go.
      { abs: path.join(dir, 'elsewhere.sqlite'), ageMs: 5 * DAY },
    ];
    const forgotten: string[] = [];
    const tspec = {
      store: 'snapshots' as const,
      label: 'appsnap',
      root,
      holdRoot: hold,
      nodeOf: snapOf,
      pruneEmptyDirs: true,
      stopWhenNoRows: false,
      rows: async () => [{ node: 'kept', files: ['o/app/kept.sqlite'] }],
      tombstones: async () => tombs,
      forget: async (abs: readonly string[]) => {
        forgotten.push(...abs);
      },
    };
    const first = await sweepOrphans(tspec);
    expect(first.removed).toEqual(['o/app/gone.sqlite']);
    expect(first.label).toBe('appsnap');
    expect(existsSync(deleted)).toBe(false);
    expect(existsSync(`${deleted}-wal`)).toBe(false);
    for (const f of [young, named, unknown]) expect(existsSync(f)).toBe(true);
    expect(first.noRow).toEqual(['o/app/mystery.sqlite']);
    expect(forgotten).toEqual([deleted]);
    // A run a day on (its age shifts with `now`): the young one goes.
    const now = Date.now();
    // A restore's hold at the store root holds this folder too.
    writeFileSync(path.join(hold, STORE_SWEEP_HOLD_FILE), '');
    const held = await sweepOrphans(tspec, { now: now + DAY });
    expect(held.held).not.toBeNull();
    expect(existsSync(young)).toBe(true);
    rmSync(path.join(hold, STORE_SWEEP_HOLD_FILE));
    // No row naming any file, but tombstones: no stop; the file the row
    // named goes too once that row is gone.
    const none = await sweepOrphans({ ...tspec, rows: async () => [] }, { now: now + DAY });
    expect(none.aborted).toBeNull();
    expect(none.removed.sort()).toEqual(['o/app/kept.sqlite', 'o/app/young.sqlite']);
    // Neither rows nor tombstones (files from before 0284): reported, never
    // a nightly stop for the snapshot folders (fix round 1, L9) ...
    tombs = [];
    const quietly = await sweepOrphans({ ...tspec, rows: async () => [] }, { now: now + DAY });
    expect(quietly.aborted).toBeNull();
    expect(quietly.noRow).toEqual(['o/app/mystery.sqlite']);
    // ... where part 1's stores stop.
    const stop = quiet();
    const wrong = await sweepOrphans(
      { ...tspec, stopWhenNoRows: undefined, rows: async () => [] },
      { now: now + DAY },
    );
    stop.mockRestore();
    expect(wrong.aborted).toMatch(/no row names any/);
    expect(existsSync(unknown)).toBe(true);
  });

  it('never removes a file a row points at again (a flip back), and a dry run removes nothing', async () => {
    root = path.join(dir, 'store-2');
    const f = put('p/b.r-9.sqlite', 3 * HOUR);
    put('p/b.r-8.sqlite', 3 * HOUR);
    const elsewhere = [{ node: 'b', files: ['p/b.r-8.sqlite'] }];
    const now = Date.now();
    await sweepOrphans(spec(elsewhere), { now });
    const back = [{ node: 'b', files: ['p/b.r-9.sqlite', 'p/b.r-8.sqlite'] }];
    expect((await sweepOrphans(spec(back), { now: now + 2 * HOUR })).removed).toEqual([]);
    // Unreferenced again: it starts its grace period over.
    expect((await sweepOrphans(spec(elsewhere), { now: now + 3 * HOUR })).removed).toEqual([]);
    const dry = await sweepOrphans(spec(elsewhere), { now: now + 5 * HOUR, dryRun: true });
    expect(dry.removed).toEqual(['p/b.r-9.sqlite']);
    expect(existsSync(f)).toBe(true);
  });

  it('never removes a file whose node has no row (a deleted item, a file from before A3b): reported', async () => {
    root = path.join(dir, 'store-3');
    const orphan = put('q/gone.sqlite', 30 * HOUR);
    const stage = put('q/gone.r-1.sqlite', 30 * HOUR);
    put('q/c.r-1.sqlite', 30 * HOUR);
    const rows = [{ node: 'c', files: ['q/c.r-1.sqlite'] }];
    const now = Date.now();
    for (const t of [now, now + 2 * HOUR, now + 4 * HOUR]) {
      const r = await sweepOrphans(spec(rows), { now: t });
      expect(r.removed).toEqual([]);
      expect(r.noRow.sort()).toEqual(['q/gone.r-1.sqlite', 'q/gone.sqlite']);
    }
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(stage)).toBe(true);
  });

  it("never removes a node's files while its row names a file that is not on disk", async () => {
    root = path.join(dir, 'store-4');
    const only = put('r/d.r-1.sqlite', 30 * HOUR);
    const rows = [{ node: 'd', files: ['r/d.r-2.sqlite'] }]; // a restored dump's revision, gone
    const now = Date.now();
    await sweepOrphans(spec(rows), { now });
    const r = await sweepOrphans(spec(rows), { now: now + 2 * HOUR });
    expect(r.removed).toEqual([]);
    expect(r.rowFileMissing).toEqual(['r/d.r-1.sqlite']);
    expect(existsSync(only)).toBe(true);
  });

  it('never removes a legacy draft name (reported)', async () => {
    root = path.join(dir, 'store-5');
    const legacy = put('s/e.draft.sqlite', 30 * HOUR);
    put('s/e.r-1.sqlite', 30 * HOUR);
    const rows = [{ node: 'e', files: ['s/e.r-1.sqlite'] }];
    const now = Date.now();
    await sweepOrphans(spec(rows), { now });
    const r = await sweepOrphans(spec(rows), { now: now + 2 * HOUR });
    expect(r.removed).toEqual([]);
    expect(r.legacy).toEqual(['s/e.draft.sqlite']);
    expect(existsSync(legacy)).toBe(true);
  });

  it('stops, removing nothing, when a row names a file outside the root (another spelling of the root, a wrong root)', async () => {
    const err = quiet();
    root = path.join(dir, 'store-6');
    const old = put('t/f.r-0.sqlite', 30 * HOUR);
    put('t/f.r-1.sqlite', 30 * HOUR);
    const now = Date.now();
    const outside = [{ node: 'f', files: [path.join(dir, 'elsewhere', 't', 'f.r-1.sqlite')] }];
    for (const t of [now, now + 2 * HOUR]) {
      const r = await sweepOrphans(spec(outside), { now: t });
      expect(r.aborted).toMatch(/outside the store's root/);
      expect(r.removed).toEqual([]);
    }
    const relative = [{ node: 'f', files: ['../t/f.r-1.sqlite'] }];
    expect((await sweepOrphans(spec(relative), { now: now + 4 * HOUR })).aborted).toMatch(
      /outside/,
    );
    expect(existsSync(old)).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('compares real paths: a root reached through a symlink, rows written under the real one', async () => {
    root = path.join(dir, 'store-7');
    const old = put('u/g.r-0.sqlite', 30 * HOUR);
    const live = put('u/g.r-1.sqlite', 30 * HOUR);
    const link = path.join(dir, 'store-7-link');
    symlinkSync(root, link);
    const rows = [{ node: 'g', files: [live] }]; // absolute, through the real path
    const now = Date.now();
    await sweepOrphans(spec(rows, link), { now });
    const r = await sweepOrphans(spec(rows, link), { now: now + 2 * HOUR });
    expect(r.aborted).toBeNull();
    expect(r.removed).toEqual(['u/g.r-0.sqlite']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(live)).toBe(true);
    // And rows written under the link while the root is the real path.
    const old2 = put('u/g.r-2.sqlite', 30 * HOUR);
    const viaLink = [{ node: 'g', files: [path.join(link, 'u', 'g.r-1.sqlite')] }];
    await sweepOrphans(spec(viaLink), { now: now + 4 * HOUR });
    expect((await sweepOrphans(spec(viaLink), { now: now + 6 * HOUR })).removed).toEqual([
      'u/g.r-2.sqlite',
    ]);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('stops when the store holds files and no row names any (a wrong or empty database)', async () => {
    const err = quiet();
    root = path.join(dir, 'store-8');
    const a = put('v/h.r-0.sqlite', 30 * HOUR);
    const now = Date.now();
    for (const t of [now, now + 2 * HOUR]) {
      const r = await sweepOrphans(spec([]), { now: t });
      expect(r.aborted).toMatch(/no row names any/);
    }
    expect(existsSync(a)).toBe(true);
    err.mockRestore();
  });

  it("a busy day: past the run's budget the oldest marked go first, the rest next run; never a stop", async () => {
    root = path.join(dir, 'store-9');
    const rows: { node: string; files: string[] }[] = [];
    const old: string[] = [];
    for (let i = 0; i < 60; i++) {
      const node = `n${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
      put(`w/${node}.r-1.sqlite`, 30 * HOUR);
      old.push(put(`w/${node}.r-0.sqlite`, 30 * HOUR));
      rows.push({ node, files: [`w/${node}.r-1.sqlite`] });
    }
    const now = Date.now();
    await sweepOrphans(spec(rows), { now });
    // 60 due of 120 files, with a budget of 20: the run removes the larger
    // of its budget and half the store, all 60, and nothing stops.
    const first = await sweepOrphans(spec(rows), { now: now + 2 * HOUR, budget: 20 });
    expect(first.aborted).toBeNull();
    expect(first.removed).toHaveLength(60); // half the store (60) is above 20
    expect(first.deferred).toBe(0);
    for (const f of old) expect(existsSync(f)).toBe(false);
  });

  it('carries what is past the budget to the next run, oldest marked first', async () => {
    root = path.join(dir, 'store-10');
    const rows: { node: string; files: string[] }[] = [];
    const now = Date.now();
    const olds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const node = `m${String.fromCharCode(97 + i)}`;
      put(`x/${node}.r-1.sqlite`, 30 * HOUR);
      rows.push({ node, files: [`x/${node}.r-1.sqlite`] });
    }
    // Two waves of old revisions, marked half an hour apart: 18 owned
    // files, half is 9, a budget of 1: 9 per run.
    for (let i = 0; i < 6; i++)
      olds.push(put(`x/m${String.fromCharCode(97 + i)}.r-0.sqlite`, 30 * HOUR));
    await sweepOrphans(spec(rows), { now });
    const late: string[] = [];
    for (let i = 0; i < 6; i++)
      late.push(put(`x/m${String.fromCharCode(97 + i)}.r-00.sqlite`, 30 * HOUR));
    await sweepOrphans(spec(rows), { now: now + HOUR / 2, budget: 1 });
    const run = await sweepOrphans(spec(rows), { now: now + 3 * HOUR, budget: 1 });
    expect(run.aborted).toBeNull();
    expect(run.removed).toHaveLength(9); // half of 18 owned
    expect(run.deferred).toBe(3);
    for (const f of olds) expect(existsSync(f)).toBe(false); // the oldest marked went first
    const next = await sweepOrphans(spec(rows), { now: now + 4 * HOUR, budget: 1 });
    expect(next.removed).toHaveLength(3);
    expect(next.deferred).toBe(0);
    for (const f of late) expect(existsSync(f)).toBe(false);
  });

  it("a restore's hold holds the sweep for a week (not a failure), unless --allow-many", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    root = path.join(dir, 'store-11');
    const old = put('y/k.r-0.sqlite', 30 * HOUR);
    put('y/k.r-1.sqlite', 30 * HOUR);
    const rows = [{ node: 'k', files: ['y/k.r-1.sqlite'] }];
    const hold = put(STORE_SWEEP_HOLD_FILE, 0);
    const now = Date.now();
    for (const t of [now, now + 2 * HOUR]) {
      const r = await sweepOrphans(spec(rows), { now: t });
      expect(r.aborted).toBeNull();
      expect(r.held).toBe(new Date(statSync(hold).mtimeMs + STORE_SWEEP_HOLD_MS).toISOString());
      expect(r.marked).toBe(0);
    }
    expect(existsSync(old)).toBe(true);
    expect(warn).toHaveBeenCalled();
    // Overridden after a dry run: the grace period starts now.
    await sweepOrphans(spec(rows), { now: now + 2 * HOUR, allowMany: true });
    const r = await sweepOrphans(spec(rows), { now: now + 4 * HOUR, allowMany: true });
    expect(r.removed).toEqual(['y/k.r-0.sqlite']);
    // A week on, the hold no longer holds.
    const t = (Date.now() - 8 * 24 * HOUR) / 1000;
    utimesSync(hold, t, t);
    expect((await sweepOrphans(spec(rows), { now: now + 5 * HOUR })).held).toBeNull();
    warn.mockRestore();
  });

  it('stops when a row names an OLDER current revision than on the last run (a restore no hold announced), unless --allow-many', async () => {
    const err = quiet();
    root = path.join(dir, 'store-13');
    const tok = (t: number) => `${t.toString(36)}0a0b0c0d`;
    const newer = `v/c.r-${tok(2_000_000)}.sqlite`;
    const older = `v/c.r-${tok(1_000_000)}.sqlite`;
    const keep = put(older, 30 * HOUR);
    put(newer, 30 * HOUR);
    const now = Date.now();
    const at = (f: string) => [{ node: 'c', files: [f], columns: [f] }];
    expect((await sweepOrphans(spec(at(newer)), { now })).aborted).toBeNull();
    for (const t of [now + 2 * HOUR, now + 4 * HOUR]) {
      const r = await sweepOrphans(spec(at(older)), { now: t });
      expect(r.aborted).toMatch(/older revision/);
      expect(r.removed).toEqual([]);
    }
    expect(existsSync(keep)).toBe(true);
    // A legacy name (no token) is older than any revision.
    expect(revisionTime('c.sqlite')).toBe(0);
    expect(revisionTime(`c.r-${tok(5)}.draft.sqlite`)).toBe(5);
    // Read and accepted: it goes on from there.
    expect((await sweepOrphans(spec(at(older)), { now, allowMany: true })).aborted).toBeNull();
    expect((await sweepOrphans(spec(at(older)), { now: now + HOUR })).aborted).toBeNull();
    err.mockRestore();
  });

  it('never marks a file younger than the grace period: a stage in flight is never left out of a backup', async () => {
    root = path.join(dir, 'store-15');
    put('t/y.r-0.sqlite', 30 * HOUR); // the revision the row names now
    const old = put('t/y.r-00.sqlite', 30 * HOUR); // an old revision
    const stage = put('t/y.r-1.sqlite', 0); // a stage whose flip is landing
    const now = Date.now();
    const r = await sweepOrphans(spec([{ node: 'y', files: ['t/y.r-0.sqlite'] }]), { now });
    expect(r.marked).toBe(1); // the old revision only
    // The stage's flip lands; a dump starts and names it; another flip moves
    // on before the backup reads the rows: the backup must keep it.
    const dumpStartedAt = now + 1000;
    expect(markedBefore(root, dumpStartedAt, dumpStartedAt)(stage)).toBe(false);
    expect(markedBefore(root, dumpStartedAt, dumpStartedAt)(old)).toBe(true);
    // A grace period on, unreferenced still, it is marked like any other.
    const later = await sweepOrphans(spec([{ node: 'y', files: ['t/y.r-0.sqlite'] }]), {
      now: now + 2 * HOUR,
    });
    expect(later.marked).toBe(1);
  });

  it('marks take the time the rows were read, not the run start', async () => {
    root = path.join(dir, 'store-14');
    const old = put('u/e.r-0.sqlite', 30 * HOUR);
    put('u/e.r-1.sqlite', 30 * HOUR);
    let readAt = 0;
    await sweepOrphans({
      ...spec([]),
      rows: async () => {
        await new Promise((r) => setTimeout(r, 50));
        readAt = Date.now();
        return [{ node: 'e', files: ['u/e.r-1.sqlite'] }];
      },
    });
    expect(markedBefore(root, readAt)(old)).toBe(false);
    expect(markedBefore(root, Date.now() + 1)(old)).toBe(true);
  });

  it('a backup leaves out only what the sweep had marked before the dump started', async () => {
    root = path.join(dir, 'store-12');
    const old = put('z/q.r-0.sqlite', 30 * HOUR);
    const live = put('z/q.r-1.sqlite', 30 * HOUR);
    const rows = [{ node: 'q', files: ['z/q.r-1.sqlite'] }];
    const now = Date.now();
    await sweepOrphans(spec(rows), { now });
    expect(markedBefore(root, now + 1)(old)).toBe(true);
    expect(markedBefore(root, now)(old)).toBe(false); // marked during the dump: kept
    expect(markedBefore(root, now + 1)(live)).toBe(false);
    // While a restore's hold is in place, nothing is left out.
    put(STORE_SWEEP_HOLD_FILE, 0);
    expect(markedBefore(root, now + 1)(old)).toBe(false);
  });
});
