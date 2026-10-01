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

import { APP_ACCESS_QUERY_SAMPLE_MS, recordAppAccess } from './app-access-log';

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
