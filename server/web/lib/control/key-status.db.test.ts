/**
 * Key status on the fleet (docs/control-center.md, "Key status on the
 * fleet") through the real app on a real migrated Postgres. One database
 * plays both sides, as control.db.test.ts does: the box (its vault keys, its
 * signed facts and keyTest cases) and the CC (its box row, the control
 * service's run, GET /api/fleet/keys and POST /api/fleet/keys/test).
 *
 *  - facts carry one line per provider key on the box's list, with its set
 *    time, its last test and its print: never the key, never a hash of it;
 *    a password row and a service off the list are not listed;
 *  - keyTest tests the keys (the provider stood in), writes the vault's own
 *    test rows, and a failed test changes nothing; its audit row holds no
 *    print;
 *  - MANTLE_CONTROL_CENTER_SCOPE=none refuses keyTest and leaves the lines
 *    out of facts;
 *  - at the CC: the run keeps the lines, the matrix leaves them out, the
 *    route shows this box first (`self`), an older box's facts (no key part)
 *    read fine and say `old-box`, a key set from the CC shows its new print
 *    and a fresh test, and Test now answers each box's fresh lines.
 *
 * Every key here is made at run time and looks like no real key; the
 * provider is a stand-in (no network).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/key-status.db.test.ts
 */
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';
import { publicKeyLine, signCall } from './sign';

type Egress = (
  input: unknown,
  init?: RequestInit,
  opts?: Record<string, unknown>,
) => Promise<Response>;
const egress = vi.hoisted(() => ({ handle: null as null | Egress }));
vi.mock('@mantle/std/egress', async (orig) => ({
  ...(await orig<typeof import('@mantle/std/egress')>()),
  egressFetch: (input: unknown, init?: RequestInit, opts?: Record<string, unknown>) =>
    egress.handle!(input, init, opts),
}));

// The vault seals under MANTLE_MASTER_KEY_NEXT (the viewer roles' passwords
// come from MANTLE_MASTER_KEY), set before @mantle/crypto loads.
vi.hoisted(() => {
  process.env.MANTLE_MASTER_KEY_NEXT ??= Buffer.alloc(32, 7).toString('base64');
});

// The provider, stood in: openrouter's model list answers for a key that
// ends in GOOD and refuses any other. Firecrawl has no test (no adapter).
const probes = vi.hoisted(() => ({ n: 0 }));
vi.mock('@mantle/voice', async (orig) => {
  const actual = await orig<typeof import('@mantle/voice')>();
  return {
    ...actual,
    getChatAdapter: (service: string) =>
      service === 'openrouter'
        ? {
            adapterName: 'stand-in',
            discoverModels: async (c: { apiKey: string }) => {
              probes.n++;
              return c.apiKey.endsWith('GOOD')
                ? { filtered: true, available: [{ id: 'vendor/model' }] }
                : { error: 'refused' };
            },
          }
        : null,
    getTtsAdapter: () => null,
    getSttAdapter: () => null,
  };
});

vi.mock('../box-status', async (orig) => ({
  ...(await orig<typeof import('../box-status')>()),
  boxStatus: () =>
    Promise.resolve({
      schema: 1,
      ts: new Date().toISOString(),
      build: { version: '0.0.0' },
      degraded: [],
    }),
}));

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const BOX = 'https://keys.example.invalid';

/** A made-up provider key of `n` characters, ending in `end`. */
const fakeKey = (head: string, end: string, n = 73) =>
  head + 'q'.repeat(n - head.length - end.length) + end;

describe.skipIf(!URL_)('key status on the fleet', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let run: typeof import('./run');
  let key: KeyObject;
  let anchor = '';
  let boxId = '';
  let ip = 0;
  const boss = randomUUID();
  const good = fakeKey(['sk', 'or', 'v1', ''].join('-'), 'GOOD');
  const bad = fakeKey(['sk', 'or', 'v1', ''].join('-'), 'NOPE');
  const crawl = fakeKey('fc-', 'ZZZZ', 35);

  /** A vault row, sealed as the vault seals it, written by the superuser. */
  const putKey = async (
    service: string,
    value: string,
    opts: { kind?: string; at?: string } = {},
  ) => {
    const { seal } = await import('@mantle/crypto');
    const id = randomUUID();
    const kind = opts.kind ?? 'token';
    const sealed = seal(value, kind === 'token' ? id : `${id}:${kind}`);
    await sql`delete from api_keys where user_id = ${anchor} and service = ${service}`;
    const at = opts.at ?? new Date().toISOString();
    await sql`insert into api_keys (id, user_id, service, label, key_enc, key_version, kind,
                created_at, updated_at)
      values (${id}, ${anchor}, ${service}, 'default', ${sealed.ciphertext}, ${sealed.keyVersion},
              ${kind}, ${at}, ${at})`;
    return id;
  };
  /** The vault's own audit row of a write to `keyId` (what setVaultKey
   *  writes), at `at`. */
  const setRow = async (keyId: string, changed: string[], at: string) => {
    await sql`insert into audit_log (actor_email, action, detail, created_at)
      values ('test', 'vault.key.set',
              ${sql.json({ keyId, name: 'x', kind: 'token', op: 'replace', changed, via: 'web' } as never)},
              ${at})`;
  };
  const post = (body: Buffer, headers: Record<string, string>) =>
    Promise.resolve(
      app.request('/api/control/call', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...headers,
        },
      }),
    );
  const signed = async (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    const res = await post(body, signCall(key, BOX, body));
    return [res.status, (await res.json()) as Row] as const;
  };
  /** The box side answers only while this process is no CC. */
  const asBox = async <T>(fn: () => Promise<T>): Promise<T> => {
    const was = process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(
      (await import('node:crypto')).createPublicKey(key),
    );
    try {
      return await fn();
    } finally {
      delete process.env.MANTLE_CONTROL_CENTER;
      delete process.env.MANTLE_CONTROL_CENTER_KEY;
      if (was !== undefined) process.env.MANTLE_IS_CONTROL_CENTER = was;
    }
  };
  const runBoxNow = () =>
    asBox(async () => {
      await sql`update control_boxes set run_requested_at = now() where id = ${boxId}`;
      await run.runDueBoxes(key);
    });
  let cookie = '';
  const fleet = async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-forwarded-for': `192.0.2.${(ip += 1) % 250}`,
        'x-forwarded-proto': 'https',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return [res.status, (await res.json()) as Row] as const;
  };
  const lineOf = (lines: unknown, service: string) =>
    (lines as Row[]).find((l) => l.service === service)!;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'key-status-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = `${BOX}/`;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_CONTROL_CENTER_SCOPE;
    m = await import('@mantle/db');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role)
      values (${boss}, ${`boss-${boss.slice(0, 8)}@example.com`}, '', 'admin')`;
    await runWorkspacesSwitch(scratch.url);
    await ensureAdminUsers(sql as never, [boss]);
    key = generateKeyPairSync('ed25519').privateKey;
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    const [b] = await sql<Row[]>`insert into control_boxes (url, added_by) values (${BOX}, 'test')
      returning id`;
    boxId = String(b!.id);
    egress.handle = async (input, init) => {
      const url = new URL(String(input));
      const h = new Headers(init?.headers);
      h.set('x-forwarded-for', `203.0.113.${(ip += 1) % 250}`);
      h.set('x-forwarded-proto', 'https');
      return app.request(url.pathname, {
        method: init?.method,
        headers: h,
        body: init?.body as BodyInit,
      });
    };
    const tokens = await import('../auth/tokens');
    const [e] = await sql<Row[]>`select session_epoch from auth.users where id = ${boss}`;
    cookie = `mantle_session=${
      tokens.buildSessionCookie(boss, { epoch: Number(e!.session_epoch), ttlSeconds: 3600 }).value
    }`;
  }, 120_000);

  afterAll(async () => {
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_PUBLIC_URL;
    delete process.env.MANTLE_CONTROL_CENTER_SCOPE;
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('facts: one line per provider key on the list, with its print, never the key', async () => {
    await putKey('openrouter', good, { at: '2026-11-01T08:00:00.000Z' });
    await putKey('firecrawl', crawl);
    await putKey('anthropic', fakeKey('pw-', 'PASS', 40), { kind: 'password' });
    await putKey('not-a-service-here', fakeKey('zz-', 'ZZZZ'));
    const [status, facts] = await asBox(() => signed({ op: 'facts' }));
    expect(status).toBe(200);
    const keys = facts.keys as Row[];
    expect(keys.map((l) => l.service)).toEqual(['firecrawl', 'openrouter']);
    expect(lineOf(keys, 'openrouter')).toEqual({
      service: 'openrouter',
      setAt: '2026-11-01T08:00:00.000Z',
      print: 'sk-or-v1-qqq…GOOD',
      testable: true,
      test: null,
    });
    expect(lineOf(keys, 'firecrawl')).toMatchObject({
      print: 'fc-q…ZZZZ',
      testable: false,
      test: null,
    });
    const text = JSON.stringify(facts);
    for (const k of [good, crawl]) {
      expect(text).not.toContain(k);
      expect(text).not.toContain(createHash('sha256').update(k).digest('hex'));
    }
    // The set time is the last write of the value: an edit of its tags or
    // label moves nothing (the row's updated_at moves, the set time not).
    const orId = String(
      (
        await sql<Row[]>`select id from api_keys
          where user_id = ${anchor} and service = 'openrouter'`
      )[0]!.id,
    );
    const setAt = async () =>
      lineOf((await asBox(() => signed({ op: 'facts' })))[1].keys, 'openrouter').setAt;
    await sql`update api_keys set updated_at = now(), tags = '{edited}' where id = ${orId}`;
    await setRow(orId, ['tags'], '2026-11-02T08:00:00.000Z');
    expect(await setAt()).toBe('2026-11-01T08:00:00.000Z');
    await setRow(orId, ['value'], '2026-11-03T08:00:00.000Z');
    expect(await setAt()).toBe('2026-11-03T08:00:00.000Z');
    await setRow(orId, ['target', 'tags'], '2026-11-04T08:00:00.000Z');
    expect(await setAt()).toBe('2026-11-03T08:00:00.000Z');
    // A status read is no use: last_used stays as it was.
    const [used] = await sql<Row[]>`select last_used from api_keys
      where user_id = ${anchor} and service = 'openrouter'`;
    expect(used!.last_used).toBeNull();
  });

  it('keyTest: tests the keys, a failed test changes nothing, and its row holds no print', async () => {
    const before = probes.n;
    const [status, ok] = await asBox(() => signed({ op: 'keyTest' }));
    expect(status).toBe(200);
    expect(ok.ok).toBe(true);
    // Only the service with a test was tested.
    expect(probes.n - before).toBe(1);
    expect(lineOf(ok.keys, 'openrouter').test).toMatchObject({ ok: true });
    expect(lineOf(ok.keys, 'firecrawl').test).toBeNull();
    // The vault's own test row, and the call's row with a count only.
    const tests = await sql<Row[]>`select detail from audit_log where action = 'vault.key.test'`;
    expect(tests.length).toBeGreaterThanOrEqual(1);
    let calls: Row[] = [];
    for (let i = 0; i < 40 && calls.length === 0; i++) {
      calls = await sql<Row[]>`select detail from audit_log
        where actor_email = 'control-center' and detail->>'op' = 'keyTest'`;
      if (calls.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls[0]!.detail).toMatchObject({ result: { ok: true, keys: 2 } });
    expect(JSON.stringify(calls)).not.toContain('…');

    // A refused key: the line says so, and the key stays as it is.
    const id = await putKey('openrouter', bad);
    const [, facts] = await asBox(() => signed({ op: 'facts' }));
    const { keyState } = await import('@mantle/db/control-center');
    // Set after its last test (that test was of another row): not tested.
    expect(keyState(lineOf(facts.keys, 'openrouter') as never)).toBe('not-tested');
    const [, refused] = await asBox(() => signed({ op: 'keyTest' }));
    const line = lineOf(refused.keys, 'openrouter');
    expect(line.test).toMatchObject({ ok: false });
    expect(keyState(line as never)).toBe('failed');
    expect(line.print).toBe('sk-or-v1-qqq…NOPE');
    const [still] = await sql<Row[]>`select id from api_keys
      where user_id = ${anchor} and service = 'openrouter'`;
    expect(still!.id).toBe(id);
  });

  it('MANTLE_CONTROL_CENTER_SCOPE=none: keyTest refused, no lines in facts', async () => {
    process.env.MANTLE_CONTROL_CENTER_SCOPE = 'none';
    try {
      const before = probes.n;
      const [status, refused] = await asBox(() => signed({ op: 'keyTest' }));
      expect([status, refused]).toEqual([200, { ok: false, reason: 'scope' }]);
      expect(probes.n).toBe(before);
      const [, facts] = await asBox(() => signed({ op: 'facts' }));
      expect(facts.keys).toBeNull();
      expect(facts.agents).toBeDefined();
    } finally {
      delete process.env.MANTLE_CONTROL_CENTER_SCOPE;
    }
  });

  it('at the CC: the run keeps the lines, the route shows this box first, the matrix none', async () => {
    await putKey('openrouter', good);
    await runBoxNow();
    process.env.MANTLE_IS_CONTROL_CENTER = 'on';
    try {
      const [status, view] = await fleet('/api/fleet/keys');
      expect(status).toBe(200);
      const boxes = view.boxes as Row[];
      expect(boxes[0]).toMatchObject({ id: 'self', keysReason: null, lastSet: null });
      expect(lineOf(boxes[0]!.keys, 'openrouter')).toMatchObject({
        print: 'sk-or-v1-qqq…GOOD',
        state: 'not-tested',
      });
      const here = boxes.find((b) => b.id === boxId)!;
      expect(here).toMatchObject({ url: BOX, keysReason: null, reason: null });
      expect(lineOf(here.keys, 'openrouter')).toMatchObject({ print: 'sk-or-v1-qqq…GOOD' });
      expect(lineOf(here.keys, 'firecrawl')).toMatchObject({ state: 'no-test' });
      expect(JSON.stringify(view)).not.toContain(good);
      // The matrix leaves the key part out.
      const [, matrix] = await fleet(`/api/fleet/matrix?box=${boxId}`);
      const facts = (matrix.boxes as Row[])[0]!.facts as Row;
      expect(facts.agents).toBeDefined();
      expect(facts).not.toHaveProperty('keys');
    } finally {
      delete process.env.MANTLE_IS_CONTROL_CENTER;
    }
  });

  it('an older box (no key part) and a newer one (an unknown part) read fine', async () => {
    const real = egress.handle!;
    const reply = async (shape: (f: Row) => Row) => {
      egress.handle = async (input, init, opts) => {
        const res = await real(input, init, opts);
        const body = JSON.parse(String(init?.body)) as { op: string };
        if (body.op !== 'facts') return res;
        return Response.json(shape((await res.json()) as Row));
      };
      try {
        await runBoxNow();
      } finally {
        egress.handle = real;
      }
      const [b] = await sql<
        Row[]
      >`select facts, facts_reason from control_boxes where id = ${boxId}`;
      return b!;
    };
    const older = await reply(({ keys: _k, ...f }) => f);
    expect(older.facts_reason).toBeNull();
    expect(older.facts).not.toHaveProperty('keys');
    const newer = await reply((f) => ({ ...f, later: { part: 1 } }));
    expect(newer.facts_reason).toBeNull();
    expect(newer.facts).not.toHaveProperty('later');
    expect(newer.facts).toHaveProperty('keys');
    // An older box's facts say old-box; a scope refusal says scope.
    await reply(({ keys: _k, ...f }) => f);
    const cc = await import('@mantle/db/control-center');
    expect(cc.keptKeyBox((await cc.listControlKeys([boxId]))[0]!).keysReason).toBe('old-box');
    await reply((f) => ({ ...f, keys: null, keysReason: 'scope' }));
    expect(cc.keptKeyBox((await cc.listControlKeys([boxId]))[0]!).keysReason).toBe('scope');
    await reply((f) => ({ ...f, keys: null, keysReason: 'error' }));
    expect(cc.keptKeyBox((await cc.listControlKeys([boxId]))[0]!).keysReason).toBe('error');
    // A bad key part costs the key part only: the other facts are kept.
    const broken = await reply((f) => ({ ...f, keys: [{ service: 'openrouter', testable: 'x' }] }));
    expect(broken.facts_reason).toBeNull();
    expect(broken.facts).toMatchObject({ keys: null, keysReason: 'bad-reply' });
    expect((broken.facts as Row).agents).toBeDefined();
    expect(cc.keptKeyBox((await cc.listControlKeys([boxId]))[0]!).keysReason).toBe('bad-reply');
    // The matrix leaves the reason out too.
    const [line] = await cc.listControlMatrix(boxId);
    expect(line!.facts).not.toHaveProperty('keysReason');
    // A bad print, from a box that sends one, is never kept.
    const odd = await reply((f) => ({
      ...f,
      keys: (f.keys as Row[]).map((l) => ({ ...l, print: good })),
    }));
    expect(JSON.stringify(odd.facts)).not.toContain(good);
  });

  it('a key set from the CC shows its new print and a fresh test, with no extra step', async () => {
    process.env.MANTLE_IS_CONTROL_CENTER = 'on';
    const fresh = fakeKey(['sk', 'or', 'v1', ''].join('-'), 'q9GOOD');
    try {
      const [status] = await fleet('/api/fleet/keys', 'POST', {
        service: 'openrouter',
        value: fresh,
        boxIds: [boxId],
      });
      expect(status).toBe(200);
      await runBoxNow();
      const [, view] = await fleet('/api/fleet/keys');
      const here = (view.boxes as Row[]).find((b) => b.id === boxId)!;
      expect(here.lastSet).toMatchObject({ service: 'openrouter', ok: true });
      expect(lineOf(here.keys, 'openrouter')).toMatchObject({
        print: 'sk-or-v1-qqq…GOOD',
        state: 'works',
      });
      expect(String(lineOf(here.keys, 'openrouter').print)).toBe(
        `${fresh.slice(0, 12)}…${fresh.slice(-4)}`,
      );
    } finally {
      delete process.env.MANTLE_IS_CONTROL_CENTER;
    }
  });

  it('Test now: this box and the linked box answer their fresh lines', async () => {
    await putKey('openrouter', bad);
    process.env.MANTLE_IS_CONTROL_CENTER = 'on';
    try {
      const asked = fleet('/api/fleet/keys/test', 'POST', {});
      // The control service's run, once the call is queued.
      for (let i = 0; i < 100; i++) {
        const [b] = await sql<Row[]>`select tool_job from control_boxes where id = ${boxId}`;
        if (JSON.stringify(b!.tool_job ?? {}).includes('keyTest')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await runBoxNow();
      process.env.MANTLE_IS_CONTROL_CENTER = 'on';
      const [status, answer] = await asked;
      expect(status).toBe(200);
      const boxes = answer.boxes as Row[];
      expect(boxes.map((b) => [b.id, b.tested])).toEqual([
        ['self', 'ok'],
        [boxId, 'ok'],
      ]);
      for (const b of boxes) {
        expect(lineOf(b.keys, 'openrouter')).toMatchObject({
          state: 'failed',
          print: 'sk-or-v1-qqq…NOPE',
        });
      }
      // One key test per box at a time: a second ask joins the first.
      const cc = await import('@mantle/db/control-center');
      const [one] = await cc.queueControlToolCalls([boxId], { kind: 'keys' }, 'test');
      const [two] = await cc.queueControlToolCalls([boxId], { kind: 'keys' }, 'test');
      expect(two!.callId).toBe(one!.callId);
      await sql`update control_boxes set tool_job = null where id = ${boxId}`;
      // A bad body is a 400; off a CC, 404.
      expect((await fleet('/api/fleet/keys/test', 'POST', { boxIds: ['nope'] }))[0]).toBe(400);
      delete process.env.MANTLE_IS_CONTROL_CENTER;
      expect((await fleet('/api/fleet/keys/test', 'POST', {}))[0]).toBe(404);
      expect((await fleet('/api/fleet/keys'))[0]).toBe(404);
    } finally {
      delete process.env.MANTLE_IS_CONTROL_CENTER;
    }
  });
});
