/**
 * The app access log stays bounded (client tier audit 2026-09-30, I4): tool
 * calls, writes and refusals land a row each, and a caller's database READS
 * at most one row per app per minute (a running app polls). The insert is
 * stood in; the reaper is proven on Postgres in app-access-log.db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@mantle/db', () => ({
  db: {},
  nodes: {},
  authUsers: {},
  appAccessLog: {},
  systemDb: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        h.rows.push(v);
        return Promise.resolve();
      },
    }),
  },
}));

import {
  APP_ACCESS_QUERY_SAMPLE_MS,
  APP_ERROR_LOG_PER_CALLER_PER_MINUTE,
  APP_ERROR_LOG_PER_DAY,
  APP_ERROR_LOG_PER_MINUTE,
  recordAppAccess,
  recordAppError,
} from './app-access-log';

const base = { ownerId: 'brain', appNodeId: 'app-1' };
const query = (actorId: string, extra: Record<string, unknown> = {}) =>
  recordAppAccess({
    ...base,
    actorId,
    kind: 'db',
    detail: { via: 'client', op: 'query', ...extra },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
  h.rows.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('recordAppAccess', () => {
  it("logs a caller's reads of one app at most once a minute", () => {
    for (let i = 0; i < 50; i += 1) query('login-a');
    expect(h.rows).toHaveLength(1);
    vi.advanceTimersByTime(APP_ACCESS_QUERY_SAMPLE_MS - 1);
    query('login-a');
    expect(h.rows).toHaveLength(1);
    vi.advanceTimersByTime(1);
    query('login-a');
    expect(h.rows).toHaveLength(2);
  });

  it('keeps callers, apps and share links apart', () => {
    query('login-b');
    query('login-c');
    recordAppAccess({
      ...base,
      appNodeId: 'app-2',
      actorId: 'login-b',
      kind: 'db',
      detail: { op: 'query' },
    });
    recordAppAccess({ ...base, shareId: 'share-1', kind: 'db', detail: { op: 'query' } });
    recordAppAccess({ ...base, shareId: 'share-2', kind: 'db', detail: { op: 'query' } });
    expect(h.rows).toHaveLength(5);
  });

  it('logs every write, tool call and refused read', () => {
    for (let i = 0; i < 3; i += 1) {
      recordAppAccess({ ...base, actorId: 'login-d', kind: 'db', detail: { op: 'exec' } });
      recordAppAccess({ ...base, actorId: 'login-d', kind: 'tool', detail: { slug: 'x' } });
      query('login-e', { refused: 'read-only' });
    }
    expect(h.rows).toHaveLength(9);
  });
});

describe('recordAppError (apps first-class plan G4)', () => {
  const fail = (appNodeId: string, extra: Record<string, unknown> = {}) =>
    recordAppError({
      ownerId: 'brain',
      appNodeId,
      source: 'db',
      via: 'owner',
      message: 'no such table: itms',
      op: 'query',
      sql: 'SELECT * FROM itms',
      status: 400,
      ...extra,
    });

  it('lands an error row with what the app was told and the statement', () => {
    fail('app-e1');
    expect(h.rows).toEqual([
      expect.objectContaining({
        appNodeId: 'app-e1',
        kind: 'error',
        detail: {
          source: 'db',
          via: 'owner',
          message: 'no such table: itms',
          op: 'query',
          sql: 'SELECT * FROM itms',
          status: 400,
        },
      }),
    ]);
  });

  it('keeps long text short', () => {
    fail('app-e2', { message: 'x'.repeat(5000), sql: 'y'.repeat(5000) });
    const detail = h.rows[0]!.detail as { message: string; sql: string };
    expect(detail.message).toHaveLength(1000);
    expect(detail.sql).toHaveLength(500);
  });

  it('one caller lands at most its own budget a minute; the owner and others still land theirs (audit item 12)', () => {
    const pub = { via: 'public', shareId: 'share-1' };
    for (let i = 0; i < 50; i += 1) fail('app-loop', pub);
    expect(h.rows).toHaveLength(APP_ERROR_LOG_PER_CALLER_PER_MINUTE);
    // The owner's errors are not spent by a visitor's.
    fail('app-loop');
    expect(h.rows).toHaveLength(APP_ERROR_LOG_PER_CALLER_PER_MINUTE + 1);
    // Another app has its own budget; the next minute starts a new one.
    fail('app-other', pub);
    expect(h.rows).toHaveLength(APP_ERROR_LOG_PER_CALLER_PER_MINUTE + 2);
    vi.advanceTimersByTime(60_000);
    fail('app-loop', pub);
    expect(h.rows).toHaveLength(APP_ERROR_LOG_PER_CALLER_PER_MINUTE + 3);
  });

  it('the callers other than the owner share APP_ERROR_LOG_PER_MINUTE per app', () => {
    for (let c = 0; c < 10; c += 1) {
      for (let i = 0; i < 5; i += 1) fail('app-many', { via: 'contact', contactId: `c${c}` });
    }
    expect(h.rows).toHaveLength(APP_ERROR_LOG_PER_MINUTE);
  });

  it('an app lands at most APP_ERROR_LOG_PER_DAY a day', () => {
    for (let m = 0; m < 400; m += 1) {
      for (let i = 0; i < 10; i += 1) fail('app-day');
      vi.advanceTimersByTime(60_000);
    }
    expect(h.rows).toHaveLength(APP_ERROR_LOG_PER_DAY);
  });
});
