/**
 * The store brokers' one helper (arch A3b, store-broker.ts), on plain files:
 * the order (no disk before the checked row), the undo inside the
 * transaction, the journal a failed commit leaves and the repair on read,
 * the database deciding. The per-store DB tests are store-brokers.db.test.ts
 * (server/web/server).
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  StoreRefusedError,
  StoreWrite,
  brokerTransaction,
  readStoreJournal,
  repairStore,
} from './store-broker';
import { editRefusalDetail, isScopeWriteRefusal } from './pg-error';

const dir = mkdtempSync(path.join(tmpdir(), 'store-broker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const fresh = () => path.join(dir, `f${++n}`);
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
/** A whole-file replace, as the stores do it: a new file renamed over. */
const replaceWith = (f: string, text: string) => () => {
  writeFileSync(`${f}.tmp`, text);
  renameSync(`${f}.tmp`, f);
};
/** A transaction that commits. */
const commits = <T>(run: (tx: null) => Promise<T>) => run(null);
/** A transaction whose work succeeds and whose COMMIT fails. */
const commitFails = async <T>(run: (tx: null) => Promise<T>): Promise<T> => {
  await run(null);
  throw new Error('commit failed');
};
const listed = () => readdirSync(dir).sort();

describe('the checked statement', () => {
  it('needs exactly one row; none or two is the edit check refusal (a 404 everywhere)', () => {
    const w = new StoreWrite('tables');
    for (const rows of [[], [1, 2]]) {
      let err: unknown;
      try {
        w.one(rows, 'table');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(StoreRefusedError);
      expect(isScopeWriteRefusal(err)).toBe(true);
      expect(editRefusalDetail(err)).toBe('no_read');
    }
    expect(new StoreWrite('tables').one([7], 'table')).toBe(7);
  });

  it('no disk step runs before it, nor before the journal', async () => {
    const f = fresh();
    const w = new StoreWrite('tables');
    await expect(w.create(f, () => writeFileSync(f, 'x'))).rejects.toThrow(/before the/);
    w.one([1], 'table');
    await expect(w.inPlace(f, () => writeFileSync(f, 'x'))).rejects.toThrow(/before the/);
    expect(() => w.remove(f)).not.toThrow(); // nothing there: nothing to do
    await expect(w.external(() => 1)).resolves.toBe(1);
    expect(existsSync(f)).toBe(false);
  });
});

describe('brokerTransaction', () => {
  it('a commit keeps the new file and leaves no journal and no pre-image', async () => {
    const f = fresh();
    writeFileSync(f, 'old');
    const before = listed();
    await brokerTransaction('tables', commits, async (_tx, w) => {
      w.one([1], 'table');
      w.journalAt(`${f}.broker`, 2, 1);
      await w.replace(f, replaceWith(f, 'new'));
    });
    expect(read(f)).toBe('new');
    expect(listed()).toEqual(before);
  });

  it('a failure after the disk write undoes it inside the transaction', async () => {
    const f = fresh();
    const made = fresh();
    const gone = fresh();
    writeFileSync(f, 'old');
    writeFileSync(gone, 'keep me');
    const before = listed();
    await expect(
      brokerTransaction('tables', commits, async (_tx, w) => {
        w.one([1], 'table');
        w.journalAt(`${f}.broker`, 2, 1);
        await w.replace(f, replaceWith(f, 'new'));
        await w.create(made, () => writeFileSync(made, 'made'));
        w.remove(gone);
        throw new Error('a later statement failed');
      }),
    ).rejects.toThrow('a later statement failed');
    expect(read(f)).toBe('old');
    expect(read(made)).toBeNull();
    expect(read(gone)).toBe('keep me');
    expect(listed()).toEqual(before);
  });

  it('a refused check writes nothing at all', async () => {
    const f = fresh();
    writeFileSync(f, 'old');
    const before = listed();
    await expect(
      brokerTransaction('tables', commits, async (_tx, w) => {
        w.one([], 'table');
        await w.replace(f, replaceWith(f, 'new'));
      }),
    ).rejects.toBeInstanceOf(StoreRefusedError);
    expect(read(f)).toBe('old');
    expect(listed()).toEqual(before);
  });

  it('a commit that fails leaves the journal; the repair trusts the database', async () => {
    const f = fresh();
    writeFileSync(f, 'old');
    const write = () =>
      brokerTransaction('tables', commitFails, async (_tx, w) => {
        w.one([1], 'table');
        w.journalAt(`${f}.broker`, 6, 5);
        await w.replace(f, replaceWith(f, 'new'));
      });
    await expect(write()).rejects.toThrow('commit failed');
    expect(read(f)).toBe('new'); // the disk is ahead
    expect(readStoreJournal(`${f}.broker`)).toMatchObject({ rev: '6', prev: '5' });
    // The database never took revision 6: the old file comes back.
    expect(repairStore(`${f}.broker`, 5)).toBe('undone');
    expect(read(f)).toBe('old');
    expect(existsSync(`${f}.broker`)).toBe(false);
    expect(listed().filter((x) => x.startsWith(path.basename(f)))).toEqual([path.basename(f)]);

    // Again, and this time the database did take it (a commit whose answer
    // was lost): the new file stays, the pre-image goes.
    await expect(write()).rejects.toThrow('commit failed');
    expect(repairStore(`${f}.broker`, 6)).toBe('committed');
    expect(read(f)).toBe('new');
    expect(listed().filter((x) => x.startsWith(path.basename(f)))).toEqual([path.basename(f)]);
    // Nothing left: the fast path.
    expect(repairStore(`${f}.broker`, 6)).toBe('clean');
  });

  it('the next write repairs a journal a failed one left, under its own lock', async () => {
    const f = fresh();
    writeFileSync(f, 'v1');
    await expect(
      brokerTransaction('tables', commitFails, async (_tx, w) => {
        w.one([1], 'table');
        w.journalAt(`${f}.broker`, 2, 1);
        await w.replace(f, replaceWith(f, 'lost'));
      }),
    ).rejects.toThrow();
    // The database still holds 1: the next write's check bumps to 2 again.
    await brokerTransaction('tables', commits, async (_tx, w) => {
      w.one([1], 'table');
      w.journalAt(`${f}.broker`, 2, 1);
      expect(read(f)).toBe('v1'); // repaired before this write's disk
      await w.replace(f, replaceWith(f, 'v2'));
    });
    expect(read(f)).toBe('v2');
    expect(existsSync(`${f}.broker`)).toBe(false);
  });

  it('a create that never committed is removed; a delete that never committed comes back', async () => {
    const made = fresh();
    await expect(
      brokerTransaction('tables', commitFails, async (_tx, w) => {
        w.inserted({ id: 1 }, 'table');
        w.journalAt(`${made}.broker`, 0, null);
        await w.create(made, () => writeFileSync(made, 'new table'));
      }),
    ).rejects.toThrow();
    expect(repairStore(`${made}.broker`, null)).toBe('undone');
    expect(read(made)).toBeNull();

    const kept = fresh();
    writeFileSync(kept, 'still here');
    await expect(
      brokerTransaction('tables', commitFails, async (_tx, w) => {
        w.one([1], 'table');
        w.journalAt(`${kept}.broker`, null, 4);
        w.remove(kept);
      }),
    ).rejects.toThrow();
    expect(read(kept)).toBeNull();
    expect(repairStore(`${kept}.broker`, 4)).toBe('undone');
    expect(read(kept)).toBe('still here');
  });

  it('an in-place write is kept (it passed its check) unless the store rebuilds it', async () => {
    const f = fresh();
    writeFileSync(f, 'a');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = () =>
      brokerTransaction('appdb', commitFails, async (_tx, w) => {
        w.one([1], 'app database');
        w.journalAt(`${f}.broker`, 3, 2);
        await w.inPlace(f, () => writeFileSync(f, 'a+b'));
      });
    await expect(write()).rejects.toThrow();
    expect(repairStore(`${f}.broker`, 2)).toBe('kept');
    expect(read(f)).toBe('a+b');
    await expect(write()).rejects.toThrow();
    expect(
      repairStore(`${f}.broker`, 2, {
        inPlace: (_j, target) => {
          writeFileSync(target, 'a');
          return true;
        },
      }),
    ).toBe('undone');
    expect(read(f)).toBe('a');
    warn.mockRestore();
  });

  it('never rolls the disk back over a newer revision', async () => {
    const f = fresh();
    writeFileSync(f, 'old');
    await expect(
      brokerTransaction('tables', commitFails, async (_tx, w) => {
        w.one([1], 'table');
        w.journalAt(`${f}.broker`, 2, 1);
        await w.replace(f, replaceWith(f, 'new'));
      }),
    ).rejects.toThrow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(repairStore(`${f}.broker`, 9)).toBe('kept');
    warn.mockRestore();
    expect(read(f)).toBe('new');
    expect(existsSync(`${f}.broker`)).toBe(false);
  });

  it('a retried transaction starts a fresh write', async () => {
    const f = fresh();
    writeFileSync(f, 'old');
    let tries = 0;
    const retries = async <T>(run: (tx: null) => Promise<T>): Promise<T> => {
      try {
        return await run(null);
      } catch {
        return run(null);
      }
    };
    await brokerTransaction('tables', retries, async (_tx, w) => {
      w.one([1], 'table');
      w.journalAt(`${f}.broker`, 2, 1);
      await w.replace(f, replaceWith(f, `try ${++tries}`));
      if (tries === 1) throw new Error('deadlock');
    });
    expect(read(f)).toBe('try 2');
    expect(existsSync(`${f}.broker`)).toBe(false);
  });
});
