/**
 * The store brokers' one helper (arch A3b, plan 20.3, store-broker.ts), on
 * plain files: the one-row check, stage then flip (a flip known not to have
 * landed takes its stage with it; one that may have committed keeps a stage
 * a row names), and the one sweep (never a live file, never before a grace
 * period, two runs apart, a SQLite file's sidecars with it; never a file
 * whose node has no row or whose row's file is missing, never a legacy
 * draft; a stop on a row outside the root, on no row at all, on too many). The
 * per-store DB tests are server/web/server/a3b-store-brokers.db.test.ts.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  StoreRefusedError,
  flipNeverLanded,
  flipRolledBack,
  inFlipTransaction,
  oneRow,
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
    const landed = vi.fn(async () => true);
    const out = await stageThenFlip(
      () => put('kept'),
      async () => 'flipped',
      rm,
      landed,
    );
    expect(out).toBe('flipped');
    expect(existsSync(f)).toBe(true);
    expect(landed).not.toHaveBeenCalled();
  });

  it('a refused flip removes its stage at once (no re-read) and throws the refusal', async () => {
    const landed = vi.fn(async () => true);
    let f = '';
    await expect(
      stageThenFlip(
        () => (f = put('refused')),
        async () => oneRow('tables', [], 'table'),
        rm,
        landed,
      ),
    ).rejects.toBeInstanceOf(StoreRefusedError);
    expect(existsSync(f)).toBe(false);
    expect(landed).not.toHaveBeenCalled();
  });

  it("a throw inside the flip's transaction (rolled back) removes the stage at once", async () => {
    const landed = vi.fn(async () => true);
    let f = '';
    await expect(
      stageThenFlip(
        () => (f = put('rolled-back')),
        () =>
          inFlipTransaction(async () => {
            throw new Error('a conflict');
          }),
        rm,
        landed,
      ),
    ).rejects.toThrow('a conflict');
    expect(existsSync(f)).toBe(false);
    expect(landed).not.toHaveBeenCalled();
    expect(flipNeverLanded(flipRolledBack(new Error('x')))).toBe(true);
    expect(flipNeverLanded(new Error('x'))).toBe(false);
  });

  it('a flip that committed and then threw (a post-commit throw, a lost COMMIT ack) keeps a stage the row names', async () => {
    for (const err of [new Error('after the commit'), new Error('write CONNECTION_CLOSED')]) {
      let f = '';
      await expect(
        stageThenFlip(
          () => (f = put(`landed-${revisionToken()}`)),
          async () => {
            throw err;
          },
          rm,
          async (s) => s === f, // the row names the stage
        ),
      ).rejects.toBe(err);
      expect(existsSync(f)).toBe(true);
    }
  });

  it('a flip that failed in a way that may have committed: removed only when no row names it; kept when the re-read fails', async () => {
    let gone = '';
    await expect(
      stageThenFlip(
        () => (gone = put('not-named')),
        async () => {
          throw new Error('the commit fails');
        },
        rm,
        async () => false,
      ),
    ).rejects.toThrow('the commit fails');
    expect(existsSync(gone)).toBe(false);
    let kept = '';
    await expect(
      stageThenFlip(
        () => (kept = put('unknown')),
        async () => {
          throw new Error('the connection is gone');
        },
        rm,
        async () => {
          throw new Error('still gone');
        },
      ),
    ).rejects.toThrow('the connection is gone');
    expect(existsSync(kept)).toBe(true);
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

  it('stops when more than the per-run limit would go; --allow-many lifts it', async () => {
    const err = quiet();
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
    const stopped = await sweepOrphans(spec(rows), { now: now + 2 * HOUR });
    expect(stopped.aborted).toMatch(/60 of 120 files would go/);
    expect(stopped.removed).toEqual([]);
    for (const f of old) expect(existsSync(f)).toBe(true);
    // A share past 10% stops it too, under the absolute limit.
    const share = await sweepOrphans(spec(rows), {
      now: now + 2 * HOUR,
      maxRemovals: 1000,
      dryRun: true,
    });
    expect(share.aborted).toMatch(/10%/);
    const many = await sweepOrphans(spec(rows), { now: now + 3 * HOUR, allowMany: true });
    expect(many.aborted).toBeNull();
    expect(many.removed).toHaveLength(60);
    for (const f of old) expect(existsSync(f)).toBe(false);
    err.mockRestore();
  });
});
