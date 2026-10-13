/**
 * The store brokers' one helper (arch A3b, plan 20.3, store-broker.ts), on
 * plain files: the one-row check, stage then flip (a flip that throws takes
 * its stage with it), and the one sweep (never a live file, never before a
 * grace period, two runs apart, a SQLite file's sidecars with it). The
 * per-store DB tests are server/web/server/a3b-store-brokers.db.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  StoreRefusedError,
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
  it('a flip that lands keeps the stage', async () => {
    const f = path.join(dir, 'kept');
    const out = await stageThenFlip(
      () => (writeFileSync(f, 'new'), f),
      async () => 'flipped',
      (s) => rmSync(s, { force: true }),
    );
    expect(out).toBe('flipped');
    expect(existsSync(f)).toBe(true);
  });

  it('a refused flip removes its stage and throws the refusal', async () => {
    const f = path.join(dir, 'refused');
    await expect(
      stageThenFlip(
        () => (writeFileSync(f, 'new'), f),
        async () => oneRow('tables', [], 'table'),
        (s) => rmSync(s, { force: true }),
      ),
    ).rejects.toBeInstanceOf(StoreRefusedError);
    expect(existsSync(f)).toBe(false);
  });
});

describe('sweepOrphans', () => {
  const HOUR = 3_600_000;
  let root = path.join(dir, 'store');
  const put = (rel: string, ageMs: number) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, rel);
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(abs, t, t);
    return abs;
  };
  const spec = (live: string[]) => ({
    store: 'tables' as const,
    root,
    owns: (rel: string) => rel.endsWith('.sqlite') && !rel.startsWith('_'),
    live: async () => new Set(live),
  });

  it('removes an old unreferenced file only on a run a grace period after it first saw it', async () => {
    root = path.join(dir, 'store-1');
    const live = put('o/a.r-1.sqlite', 3 * HOUR);
    const old = put('o/a.r-0.sqlite', 3 * HOUR);
    put('o/a.r-0.sqlite-wal', 3 * HOUR);
    const history = put('_snapshots/o/a/x.sqlite', 3 * HOUR);
    const other = put('o/notes.txt', 3 * HOUR);
    const now = Date.now();
    const first = await sweepOrphans(spec(['o/a.r-1.sqlite']), { now });
    expect(first.removed).toEqual([]);
    expect(first.marked).toBe(1);
    // Too soon: still kept.
    expect((await sweepOrphans(spec(['o/a.r-1.sqlite']), { now: now + 1000 })).removed).toEqual([]);
    // A stage made just before the next run: still in flight.
    const fresh = put('o/a.r-2.sqlite', -HOUR + 1000);
    // A grace period later: the old revision goes, with its sidecar; the
    // stage is younger than the grace period.
    const later = await sweepOrphans(spec(['o/a.r-1.sqlite']), { now: now + HOUR });
    expect(later.removed).toEqual(['o/a.r-0.sqlite']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(`${old}-wal`)).toBe(false);
    for (const kept of [live, fresh, history, other]) expect(existsSync(kept)).toBe(true);
  });

  it('never removes a file a row points at again (a flip back), and a dry run removes nothing', async () => {
    root = path.join(dir, 'store-2');
    const f = put('p/b.r-9.sqlite', 3 * HOUR);
    const now = Date.now();
    await sweepOrphans(spec([]), { now });
    expect((await sweepOrphans(spec(['p/b.r-9.sqlite']), { now: now + 2 * HOUR })).removed).toEqual(
      [],
    );
    // Unreferenced again: it starts its grace period over.
    expect((await sweepOrphans(spec([]), { now: now + 3 * HOUR })).removed).toEqual([]);
    const dry = await sweepOrphans(spec([]), { now: now + 5 * HOUR, dryRun: true });
    expect(dry.removed).toEqual(['p/b.r-9.sqlite']);
    expect(existsSync(f)).toBe(true);
  });
});
