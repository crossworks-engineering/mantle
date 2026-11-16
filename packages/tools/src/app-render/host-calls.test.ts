/**
 * The one door from a picture of an app to the brain (host-calls.ts): only
 * `db.query` reaches data, through the read-only query on the 'app-data'
 * door, as the caller; every other bridge call, a write, a tool, the hub, a
 * call kind nobody knows, is refused and named for the report, and touches
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reads: [] as unknown[][],
  doors: [] as string[],
  fail: null as Error | null,
}));

vi.mock('@mantle/db', () => ({
  asSystem: async (fn: () => Promise<unknown>, reason: string) => {
    h.doors.push(reason);
    return fn();
  },
}));
vi.mock('@mantle/content/app-broker', () => ({
  appDbReadQuery: async (...args: unknown[]) => {
    h.reads.push(args);
    if (h.fail) throw h.fail;
    return { rows: [{ n: 1 }], empty: false };
  },
}));

import { answerRenderHostCall } from './host-calls';

const ctx = {
  ownerId: 'owner-1',
  appId: 'app-1',
  viewer: { kind: 'member' as const, loginId: 'login-1' },
  callerKey: 'member:login-1',
};

beforeEach(() => {
  h.reads = [];
  h.doors = [];
  h.fail = null;
});

describe('answerRenderHostCall', () => {
  it('answers a query with the rows, read only, as the caller, on the app-data door', async () => {
    const out = await answerRenderHostCall(ctx, {
      v: 1,
      id: 'r1',
      kind: 'db.query',
      sql: 'SELECT * FROM t WHERE who = :host_me_id',
      params: [3],
    });
    expect(out).toEqual({ ok: true, output: [{ n: 1 }] });
    expect(h.reads).toEqual([
      [
        'owner-1',
        'app-1',
        'SELECT * FROM t WHERE who = :host_me_id',
        [3],
        { viewer: ctx.viewer, callerKey: 'member:login-1' },
      ],
    ]);
    expect(h.doors).toEqual(['app-data']);
  });

  it.each([
    [{ kind: 'db.exec', sql: 'DELETE FROM t' }, 'db.exec'],
    [{ kind: 'db.batch', statements: [{ sql: 'DELETE FROM t' }] }, 'db.batch'],
    [{ kind: 'tool.call', slug: 'file_sql', input: {} }, 'tool.call file_sql'],
    [{ kind: 'tool.call', slug: 'email_send', input: { to: 'x' } }, 'tool.call email_send'],
    [{ kind: 'tool.call', slug: 'a b<script>' }, 'tool.call'],
    [{ kind: 'hub.get' }, 'hub.get'],
    [{ kind: 'db.Query', sql: 'SELECT 1' }, 'db.Query'],
    [{ kind: 'something new' }, 'an unknown call'],
    [{ kind: 7 }, 'an unknown call'],
    [{}, 'an unknown call'],
  ])('refuses %j and touches nothing', async (message, label) => {
    const out = await answerRenderHostCall(ctx, { v: 1, id: 'r', ...message });
    expect(out).toMatchObject({ ok: false, reason: 'render', refused: label });
    expect(h.reads).toEqual([]);
    expect(h.doors).toEqual([]);
  });

  it('refuses a query with no SQL text or with values that are not a list', async () => {
    for (const m of [
      { kind: 'db.query' },
      { kind: 'db.query', sql: '  ' },
      { kind: 'db.query', sql: 'x'.repeat(100_001) },
      { kind: 'db.query', sql: 'SELECT 1', params: { a: 1 } },
      { kind: 'db.query', sql: 'SELECT 1', params: Array.from({ length: 1001 }, () => 1) },
    ]) {
      expect((await answerRenderHostCall(ctx, m)).ok).toBe(false);
    }
    expect(h.reads).toEqual([]);
  });

  it("hands the query's own error back to the app, short", async () => {
    h.fail = new Error('attempt to write a readonly database '.repeat(40));
    const out = await answerRenderHostCall(ctx, { kind: 'db.query', sql: 'DELETE FROM t' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.length).toBeLessThanOrEqual(500);
    expect(!out.ok && out.refused).toBeUndefined();
  });
});
