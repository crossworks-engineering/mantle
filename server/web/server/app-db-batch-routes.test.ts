/**
 * host.db.batch at the three db brokers, without a database: who may call it,
 * what each failure answers and logs, and that the old calls answer as they
 * did. There is no rights check of the batch's own: a batch is a write, so each
 * runner's write rule answers. The transaction itself is
 * packages/content/src/app-sql-batch.test.ts; the broker on Postgres is
 * packages/content/src/app-db-batch.db.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '11111111-1111-4111-8111-111111111111';
const ADMIN_LOGIN = '22222222-2222-4222-8222-222222222222';
const MEMBER_LOGIN = '33333333-3333-4333-8333-333333333333';
const APP = '44444444-4444-4444-8444-444444444444';
const SHARE = '55555555-5555-4555-8555-555555555555';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'batch-share-token';

const h = vi.hoisted(() => ({
  login: 'admin' as 'admin' | 'member',
  /** The member's Write switch; Informational on the app; Can write on the
   *  share; the link names a contact. */
  writable: true,
  informational: false,
  canWrite: true,
  contact: true,
  /** The next batch fails with this, made from the real error classes. */
  fail: null as null | 'guard' | 'statement' | 'busy' | 'lost',
  order: [] as string[],
  batches: [] as Array<{ batch: unknown; caller: Record<string, unknown> }>,
  execs: 0,
  errors: [] as Array<Record<string, unknown>>,
  access: [] as Array<Record<string, unknown>>,
  trail: [] as Array<Record<string, unknown>>,
}));

// adminFacts answers what the stood-in Login (loginStandIn) says of it.
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn((await import('@/server/run-route-stand-ins')).adminFactsStandIn),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const { loginStandIn } = await import('@/server/run-route-stand-ins');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    ownerLoginCaller: vi.fn(() =>
      h.login === 'admin'
        ? loginStandIn({
            loginId: ADMIN_LOGIN,
            brainId: ANCHOR,
            email: 'jo@example.invalid',
            displayName: 'Jo',
            admin: true,
          })
        : loginStandIn({
            loginId: MEMBER_LOGIN,
            brainId: ANCHOR,
            email: 'pat@example.invalid',
            displayName: 'Pat',
          }),
    ),
  };
});

vi.mock('@/lib/member-apps', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  memberAppOr404: vi.fn(async (anchor: string, id: string) => ({
    id,
    ownerId: anchor,
    title: 'Polls',
    // The lookup folds Informational into this one answer (member-apps.ts).
    writable: h.writable && !h.informational,
    dataReadOnly: h.informational,
    manifest: { sqlite: undefined },
    publishedBuild: { ok: true },
  })),
}));

vi.mock('@/lib/contact-share-gate', () => ({
  gateShare: vi.fn(async () => ({
    kind: 'ok',
    share: {
      id: SHARE,
      ownerId: ANCHOR,
      nodeId: APP,
      nodeType: 'app',
      contactId: h.contact ? CONTACT : null,
      canWrite: h.canWrite,
    },
  })),
  contactCodeRequired: vi.fn(() => new Response('code required', { status: 401 })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async (_owner: string, id: string) => ({
    id,
    dataReadOnly: h.informational,
    manifest: { sqlite: undefined },
    publishedBuild: { ok: true },
  })),
  recordAppAccess: vi.fn((e: Record<string, unknown>) => void h.access.push(e)),
  recordAppError: vi.fn((e: Record<string, unknown>) => void h.errors.push(e)),
  recordShareAccess: vi.fn((e: Record<string, unknown>) => void h.trail.push(e)),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  asSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/app-broker')>();
  return {
    ...real,
    appDbQuery: vi.fn(async () => []),
    appDbExec: vi.fn(async () => {
      h.execs += 1;
      return { changes: 1, lastInsertRowid: 7 };
    }),
    appDbBatch: vi.fn(
      async (_o: string, _a: string, batch: unknown, _s: unknown, caller: never) => {
        h.order.push('batch');
        h.batches.push({ batch, caller });
        if (h.fail === 'guard') throw new real.AppDbGuardError();
        if (h.fail === 'statement') {
          throw new real.AppSqlBatchError(1, 2, 'UNIQUE constraint failed: t.k');
        }
        if (h.fail === 'busy') throw new real.AppSqlBusyError('another write holds it');
        if (h.fail === 'lost') throw new Error('secret /path/on/server');
        return { changes: [1, 1] };
      },
    ),
    ensureAppDatabase: vi.fn(async () => void h.order.push('registry')),
    markAppClientWritten: vi.fn(async () => void h.order.push('marked')),
  };
});

vi.mock('@mantle/content/app-table-exports', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scheduleAppTableExportSync: vi.fn(() => void h.order.push('sync')),
}));

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;
let ownerDb: Handler<{ id: string }>;
let linkDb: Handler<{ token: string }>;
let body: typeof import('@/lib/app-db-broker-body');
let appAnswerOf: typeof import('./test-support').appAnswerOf;

const request = (json: unknown) =>
  new Request('http://test.invalid/db-broker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  });
const callOwner = (json: unknown) =>
  ownerDb(request(json), { params: Promise.resolve({ id: APP }) });
const callLink = (json: unknown) =>
  linkDb(request(json), { params: Promise.resolve({ token: TOKEN }) });

const BATCH = {
  op: 'batch',
  statements: [
    { sql: 'INSERT INTO t VALUES (1)' },
    { sql: 'INSERT INTO t VALUES (2)', params: [] },
  ],
};

beforeAll(async () => {
  process.env.SESSION_SECRET ??= 'app-db-batch-routes-secret-at-least-32-chars';
  ownerDb = (await import('../app/api/apps/[id]/db-broker/route')).POST;
  linkDb = (await import('../app/s/[token]/db-broker/route')).POST;
  body = await import('@/lib/app-db-broker-body');
  ({ appAnswerOf } = await import('./test-support'));
}, 60_000);

beforeEach(() => {
  h.login = 'admin';
  h.writable = true;
  h.informational = false;
  h.canWrite = true;
  h.contact = true;
  h.fail = null;
  h.order.length = 0;
  h.batches.length = 0;
  h.execs = 0;
  h.errors.length = 0;
  h.access.length = 0;
  h.trail.length = 0;
});

describe('who may call it: a batch is a write', () => {
  it('Admin: runs, Informational or not, and is never refused', async () => {
    for (const informational of [false, true]) {
      h.informational = informational;
      h.batches.length = 0;
      const res = await callOwner(BATCH);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, output: { changes: [1, 1] } });
      expect(h.batches).toHaveLength(1);
    }
  });

  it('Member with the Write switch: runs, and its access is logged as a batch', async () => {
    h.login = 'member';
    const res = await callOwner(BATCH);
    expect(res.status).toBe(200);
    expect(h.batches).toHaveLength(1);
    expect(h.access.at(-1)).toMatchObject({ detail: { via: 'member', op: 'batch' } });
    expect(h.batches[0]!.caller).toMatchObject({
      callerKey: `member:${MEMBER_LOGIN}`,
      viewer: { kind: 'member', loginId: MEMBER_LOGIN },
    });
  });

  it.each([
    ['Write off', { writable: false, informational: false }],
    ['Informational', { writable: true, informational: true }],
  ])('Member, %s: 403 read-only, nothing runs', async (_name, flags) => {
    h.login = 'member';
    Object.assign(h, flags);
    const res = await callOwner(BATCH);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'read-only' });
    expect(h.batches).toHaveLength(0);
    expect(h.access.at(-1)).toMatchObject({ detail: { op: 'batch', refused: 'read-only' } });
  });

  it('Contact with Can write: marks as written from outside BEFORE the write, then syncs', async () => {
    const res = await callLink(BATCH);
    expect(res.status).toBe(200);
    expect(h.order).toEqual(['registry', 'marked', 'batch', 'sync']);
    expect(h.trail.at(-1)).toMatchObject({ kind: 'write' });
    expect(h.batches[0]!.caller).toMatchObject({
      callerKey: `share:${SHARE}`,
      viewer: { kind: 'contact', contactId: CONTACT },
    });
  });

  it('Contact without Can write: 403 read-only, logged, nothing runs', async () => {
    h.canWrite = false;
    const res = await callLink(BATCH);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'read-only' });
    expect(h.batches).toHaveLength(0);
    expect(h.order).toEqual([]);
    expect(h.trail.at(-1)).toMatchObject({ kind: 'refused', detail: { op: 'batch' } });
  });

  it('Contact on an Informational app: 403 read-only, nothing runs', async () => {
    h.informational = true;
    const res = await callLink(BATCH);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'read-only' });
    expect(h.batches).toHaveLength(0);
    expect(h.trail.at(-1)).toMatchObject({ kind: 'refused', detail: { refused: 'informational' } });
  });

  it('An open link: 403, nothing runs', async () => {
    h.contact = false;
    const res = await callLink(BATCH);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'read-only' });
    expect(h.batches).toHaveLength(0);
    expect(h.order).toEqual([]);
  });
});

describe('what a failure answers and logs', () => {
  const runners: Array<[string, () => Promise<Response>, () => void]> = [
    ['Admin', () => callOwner(BATCH), () => void (h.login = 'admin')],
    ['Member', () => callOwner(BATCH), () => void (h.login = 'member')],
    ['Contact', () => callLink(BATCH), () => void 0],
  ];

  it.each(runners)('%s: a guard refusal is 409, no fault, no sync', async (_who, call, setup) => {
    setup();
    h.fail = 'guard';
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'guard' });
    expect(h.errors).toEqual([]);
    expect(h.order).not.toContain('sync');
  });

  it.each(runners)(
    '%s: a failed statement is 400, logged with that statement, and the sync still runs',
    async (_who, call, setup) => {
      setup();
      h.fail = 'statement';
      const res = await call();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: 'statement 2 of 2: UNIQUE constraint failed: t.k',
      });
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatchObject({
        source: 'db',
        op: 'batch',
        sql: 'INSERT INTO t VALUES (2)',
        status: 400,
      });
      expect(h.order).toContain('sync');
    },
  );

  it.each(runners)('%s: busy is 429, no fault', async (_who, call, setup) => {
    setup();
    h.fail = 'busy';
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toMatchObject({ reason: 'busy' });
    expect(h.errors).toEqual([]);
  });

  it('a server fault keeps its words from the app, and the sync still runs: the commit may have landed', async () => {
    h.fail = 'lost';
    const res = await callOwner(BATCH);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
    expect(h.order).toContain('sync');
  });
});

describe('the body', () => {
  const statements = (n: number) => Array.from({ length: n }, () => ({ sql: 'SELECT 1' }));
  const refused = async (json: unknown, words: RegExp) => {
    const res = await callOwner(json);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(words);
    expect(h.batches).toHaveLength(0);
    expect(h.execs).toBe(0);
  };

  it('takes 2,000 statements and refuses 2,001', async () => {
    expect((await callOwner({ op: 'batch', statements: statements(2000) })).status).toBe(200);
    h.batches.length = 0;
    await refused({ op: 'batch', statements: statements(2001) }, /statements/);
  });

  it('refuses no statements, a long statement and too many values', async () => {
    await refused({ op: 'batch', statements: [] }, /statements/);
    await refused({ op: 'batch', statements: [{ sql: 'x'.repeat(20_001) }] }, /statements\.0\.sql/);
    await refused(
      { op: 'batch', statements: [{ sql: 'SELECT 1', params: Array(1000).fill(1) }] },
      /statements\.0\.params/,
    );
    await refused(
      { op: 'batch', statements: [{ sql: 'SELECT 1' }], guard: { sql: 'x'.repeat(20_001) } },
      /guard\.sql/,
    );
  });

  it('refuses a misspelt key and a guard that brings its own words', async () => {
    await refused({ op: 'batch', statements: [{ sql: 'SELECT 1', param: [1] }] }, /statements\.0/);
    await refused(
      { op: 'batch', statements: [{ sql: 'SELECT 1' }], guard: { sql: 'SELECT 1', error: 'no' } },
      /guard/,
    );
  });

  it('refuses a misspelt guard, so writes never run with no check', async () => {
    await refused(
      { op: 'batch', statements: [{ sql: 'SELECT 1' }], gaurd: { sql: 'SELECT 1' } },
      /body|gaurd/,
    );
  });

  it('an old client (a batch sent as a bare exec) gets 400, and nothing is written', async () => {
    await refused({ op: 'exec', params: [] }, /sql: missing.*older than the app/);
  });

  it('a new client on an unknown op gets 400', async () => {
    await refused({ op: 'merge', sql: 'SELECT 1' }, /op/);
  });

  it('the guard reaches the broker', async () => {
    const guard = { sql: 'SELECT 1 FROM t WHERE k = ?', params: ['a'] };
    await callOwner({ ...BATCH, guard });
    expect(h.batches[0]!.batch).toMatchObject({ guard });
  });

  it('over the route ceiling answers 413', async () => {
    const { capRequestBody, bodyCeilingFor } = await import('../lib/body-limit');
    const ceiling = bodyCeilingFor(`/s/${TOKEN}/db-broker`) as number;
    const size = ceiling + 1;
    const req = capRequestBody(
      new Request(`http://test.invalid/s/${TOKEN}/db-broker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'batch', statements: [{ sql: 'x'.repeat(size) }] }),
      }),
      ceiling,
    );
    const res = await appAnswerOf(
      linkDb(req, { params: Promise.resolve({ token: TOKEN }) }),
      `http://test.invalid/s/${TOKEN}/db-broker`,
    );
    expect(res.status).toBe(413);
    expect(h.batches).toHaveLength(0);
  });

  it('the Admin route holds a batch to 8 MiB, and an old large exec passes as it did', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    const batch = await callOwner({
      op: 'batch',
      statements: [{ sql: 'SELECT ?', params: [big] }],
    });
    expect(batch.status).toBe(413);
    expect(await batch.json()).toMatchObject({ reason: 'body-too-large' });
    expect(h.batches).toHaveLength(0);
    const exec = await callOwner({ op: 'exec', sql: 'INSERT INTO t VALUES (?)', params: [big] });
    expect(exec.status).toBe(200);
  });

  it('names the failing statement for the error log', async () => {
    const { appDbFailedSql } = body;
    const { AppSqlBatchError } = await import('@mantle/content/app-broker');
    const data = {
      op: 'batch' as const,
      statements: [
        { sql: 'A', params: [] },
        { sql: 'B', params: [] },
      ],
      guard: { sql: 'G', params: [] },
    };
    expect(appDbFailedSql({ op: 'exec', sql: 'X', params: [] }, new Error('e'))).toBe('X');
    expect(appDbFailedSql(data, new AppSqlBatchError(1, 2, 'e'))).toBe('B');
    expect(appDbFailedSql(data, new AppSqlBatchError('guard', 2, 'e'))).toBe('G');
    expect(appDbFailedSql(data, new AppSqlBatchError('commit', 2, 'e'))).toBeUndefined();
    expect(appDbFailedSql(data, new Error('e'))).toBeUndefined();
  });
});

describe('the old calls answer as they did', () => {
  it('exec, byte for byte', async () => {
    const res = await callOwner({ op: 'exec', sql: 'INSERT INTO t VALUES (1)' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true,"output":{"changes":1,"lastInsertRowid":7}}');
    expect(h.execs).toBe(1);
  });

  it('a query on an open link still runs', async () => {
    h.contact = false;
    const res = await callLink({ op: 'query', sql: 'SELECT 1' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true,"output":[]}');
  });

  it('an exec on an open link still answers its old 403', async () => {
    h.contact = false;
    const res = await callLink({ op: 'exec', sql: 'DELETE FROM t' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      reason: 'read-only',
      error: 'Shared apps are read-only — database writes are disabled on public links.',
    });
  });
});
