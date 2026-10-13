import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionGone, END_SESSION_SQL, reserveLease, withLease } from './reserved';

/**
 * The reserved-connection lease (reserved.ts, hotfix after v0.300.13): a
 * connection that is gone is never handed back and takes no statement. The
 * same on a real database: reserved.db.test.ts.
 */

const err = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

describe('connectionGone: strict, so a live connection is never kept reserved', () => {
  it('the driver’s connection errors, socket errors, a FATAL or PANIC', () => {
    for (const code of [
      'CONNECTION_CLOSED',
      'CONNECTION_DESTROYED',
      'CONNECTION_ENDED',
      'CONNECT_TIMEOUT',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
    ]) {
      expect(connectionGone(err({ code })), code).toBe(true);
    }
    expect(connectionGone(err({ code: '57P01', severity: 'FATAL' }))).toBe(true);
    expect(connectionGone(err({ code: 'XX000', severity: 'PANIC' }))).toBe(true);
  });

  it('not a statement’s own error, nor anything wrapped', () => {
    for (const e of [
      err({ code: '22012', severity: 'ERROR' }),
      err({ code: '25P02', severity: 'ERROR' }),
      err({ code: '57014', severity: 'ERROR' }), // a cancel leaves the session open
      err({ code: 'UNDEFINED_VALUE' }),
      err({ code: 'MAX_PARAMETERS_EXCEEDED' }),
      err({ cause: err({ code: 'CONNECTION_CLOSED' }) }),
      new Error('CONNECTION_CLOSED'),
      'CONNECTION_CLOSED',
      null,
      undefined,
    ]) {
      expect(connectionGone(e)).toBe(false);
    }
  });
});

/** A reserved connection that records what is sent and released. */
function fakePool(fail?: (q: string) => unknown) {
  const sent: string[] = [];
  let released = 0;
  const stmt = (q: string) => {
    sent.push(q);
    const why = fail?.(q);
    const p = why ? Promise.reject(why) : Promise.resolve([]);
    p.catch(() => {});
    return Object.assign(p, { simple: () => p });
  };
  const conn = { unsafe: stmt, release: () => (released += 1) };
  return {
    pool: { reserve: async () => conn } as never,
    sent,
    released: () => released,
  };
}

describe('the lease', () => {
  it('a usable connection goes back once', async () => {
    const f = fakePool();
    const lease = await reserveLease(f.pool);
    await lease.watch(lease.sql.unsafe('select 1'));
    lease.release();
    lease.release();
    expect(f.released()).toBe(1);
  });

  it('a statement’s own error keeps it usable', async () => {
    const f = fakePool(() => err({ code: '23505', severity: 'ERROR' }));
    await expect(
      withLease(f.pool, async (l) => {
        await l.watch(l.sql.unsafe('insert'));
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(f.released()).toBe(1);
  });

  it('a connection error: gone, not handed back, end sends nothing', async () => {
    const f = fakePool(() => err({ code: 'CONNECTION_CLOSED' }));
    const lease = await reserveLease(f.pool);
    await expect(lease.watch(lease.sql.unsafe('select 1'))).rejects.toThrow();
    expect(lease.gone).toBe(true);
    await lease.end();
    lease.release();
    expect(f.sent).toEqual(['select 1']);
    expect(f.released()).toBe(0);
  });

  it('withLease: a connection error thrown out of fn counts too', async () => {
    const f = fakePool();
    await expect(
      withLease(f.pool, async () => {
        throw err({ code: 'ECONNRESET' });
      }),
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(f.released()).toBe(0);
  });

  it('end on a live connection ends its session and never hands it back', async () => {
    const f = fakePool((q) => (q === END_SESSION_SQL ? err({ code: '25P02' }) : undefined));
    const lease = await reserveLease(f.pool);
    await lease.end();
    await lease.end();
    lease.release();
    expect(f.sent).toEqual([END_SESSION_SQL]);
    expect(f.released()).toBe(0);
  });
});

describe('every reserve goes through the lease', () => {
  it('no tracked non-test file but reserved.ts calls reserve()', () => {
    const root = join(__dirname, '..', '..', '..');
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '-l', '-E', '\\.reserve\\(\\)', '--', 'packages', 'server'],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );
    } catch (e) {
      // git grep exits 1 when nothing matches.
      if ((e as { status?: number }).status !== 1) throw e;
    }
    const offenders = out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f))
      .filter((f) => !/\.test\.ts$/.test(f))
      .filter((f) => f !== 'packages/db/src/reserved.ts');
    expect(offenders).toEqual([]);
  });
});
