/**
 * The area check folded into the gate's step 5 (plan v3.2 S9 part 2), on a
 * real migrated Postgres through the real app (createApp): what an area
 * row answers each credential, recorded on main BEFORE the fold
 * (S9_AREA_RECORD=1 writes `__snapshots__/s9-area-fold.<mode>.txt`) and
 * compared line for line after it. The cases the session guard's own area
 * check still answered on main, each refused the same way after:
 *
 *  - the asset rows (GET and HEAD /api/attachments/:id, the connectors
 *    area, caller ownerAsset): the session cookie, an `?at=` asset token
 *    and the render cookie of an Admin user with the area, of one without
 *    it, of a member, and none;
 *  - an area read that fails (requireArea throws): every time, and only
 *    the first time (main asked the area again in the guard and could
 *    pass; the fold answers the failure, never a pass);
 *  - member and no-area Admin negative cells on a sample of area rows, one
 *    or more of each area, reads and writes.
 *
 *  - an Admin user's device token (a mobile bearer) on area rows (S9 part
 *    2 round 2): the Admin user with the area answers 200 on GET
 *    /api/users, the one without it and a member are refused.
 *
 * The third case (a guard read after the request changed a login,
 * `logins.changed`) has no route that reaches it: a handler reads the
 * answer the gate kept and calls no guard. Its cell is the stand-in test
 * (gate-login.test.ts, "an Admin login whose area is taken away"), where
 * the guard asks the area again, as on main (round 2, the CEO ruling).
 *
 * The device token cells run in every lane the file runs in: the full DB
 * run (both shards), test:runtime-role and the full run with the runtime
 * role off (MANTLE_DB_RUNTIME_ROLE=0), each against the one record.
 *
 * Run in the full DB run (the actor check warn) and test:actor-on (on).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/s9-area-fold.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { warmWorkspacesMock } from '../test-support/workspaces-mock';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MODE = process.env.MANTLE_ACTOR_CHECK || 'default';
const RECORDED = join(
  dirname(fileURLToPath(import.meta.url)),
  '__snapshots__',
  `s9-area-fold.${MODE}.txt`,
);

/** The forced area-read failure: off, every ask, or the next ask only. */
const failArea = vi.hoisted(() => ({ mode: 'off' as 'off' | 'always' | 'once' }));

vi.mock('../workspaces', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspaces')>();
  return {
    ...real,
    requireArea: async (...args: Parameters<typeof real.requireArea>) => {
      if (failArea.mode === 'always') throw new Error('s9 area read failure');
      if (failArea.mode === 'once') {
        failArea.mode = 'off';
        throw new Error('s9 area read failure');
      }
      return real.requireArea(...args);
    },
  };
});

type Row = Record<string, unknown>;

/** Ids, stamps and minted values out of an answer, so two fresh brains
 *  answer the same text. */
function normal(text: string): string {
  // The login emails and the box's tailnet peers (the environment, not an
  // answer; no machine name on the record) last, after the cut, as the
  // record on main was read.
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
    .slice(0, 300)
    .replace(/s9af-[0-9a-f]{8}-[0-9a-f]{8}@example\.com/g, '<email>')
    .replace(/"tailnetPeers":\[[^\]]*\]?/g, '"tailnetPeers":"<env>"');
}

describe.skipIf(!URL)('S9 part 2: the area check in the gate, recorded on main', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let tokens: typeof import('./tokens');
  const tag = `s9af-${randomUUID().slice(0, 8)}`;
  const adm = randomUUID(); // an Admin user, every area
  const noArea = randomUUID(); // an Admin user, every area off
  const mem = randomUUID(); // a member
  let anchor = '';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;
  const cells: string[] = [];

  const cookieAt = (id: string) =>
    `mantle_session=${tokens.buildSessionCookie(id, { epoch: 0 }).value}`;
  const renderAt = (id: string) =>
    `mantle_render=${tokens.buildRenderToken({ ownerId: anchor, actorId: id, nodeId: randomUUID() })}`;
  const atOf = (id: string) => tokens.buildAssetToken(anchor, id, 0);
  /** Each login's device token (a row in mobile_tokens), by login id. */
  const bearers = new Map<string, string>();

  const call = async (
    method: string,
    path: string,
    cookie: string | null,
    body?: unknown,
  ): Promise<string> => {
    ip += 1;
    const headers: Record<string, string> = {
      'x-forwarded-for': `198.51.100.${ip % 250}`,
      'content-type': 'application/json',
    };
    if (cookie?.startsWith('Bearer ')) headers.authorization = cookie;
    else if (cookie) headers.cookie = cookie;
    const res = await app.request(path, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
    return `${res.status} ${normal(text)}`;
  };

  /** One cell: its name and its answer, on the record. */
  const cell = async (name: string, answer: Promise<string>) => {
    const a = await answer;
    cells.push(`${name} = ${a}`);
    return a;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 's9-area-fold-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    // The mocked area module resolved alone, before any request (S9 part 3
    // round 2), here: after the database's environment is set.
    await warmWorkspacesMock();
    m = await import('@mantle/db');
    const sql = (m.systemDb as unknown as { $client: ReturnType<typeof superuserClient> }).$client;
    tokens = await import('./tokens');
    anchor = await ensureTestAnchor(sql as never);
    const hash = bcrypt.hashSync('s9 area fold 1', 4);
    const su = superuserClient(scratch.url);
    try {
      await su`insert into auth.users (id, email, password_hash, role) values
        (${adm}, ${emailOf(adm)}, ${hash}, 'admin'), (${noArea}, ${emailOf(noArea)}, ${hash}, 'admin'),
        (${mem}, ${emailOf(mem)}, ${hash}, 'member')`;
    } finally {
      await su.end();
    }
    await runWorkspacesSwitch(scratch.url);
    const su2 = superuserClient(scratch.url);
    try {
      const [a] = await su2<Row[]>`select id::text as id from workspaces
                                    where owner_id = ${anchor} and is_admin`;
      await su2`insert into workspace_users (workspace_id, login_id, moderator)
                values (${a!.id as string}, ${noArea}, false) on conflict do nothing`;
      // The object, not its text: postgres.js serialises a jsonb parameter
      // itself (a string would land as a JSON string, switching nothing off).
      await su2`update workspace_users set limits = ${su2.json({
        areas: { settings: false, users: false, assistants: false, connectors: false, keys: false },
      })} where workspace_id = ${a!.id as string} and login_id = ${noArea}`;
      const [lim] = await su2<Row[]>`select limits -> 'areas' ->> 'users' as users
                                    from workspace_users
                                    where workspace_id = ${a!.id as string} and login_id = ${noArea}`;
      expect(lim?.users).toBe('false');
      await su2`insert into workspace_users (workspace_id, login_id, moderator)
                values (${a!.id as string}, ${adm}, false) on conflict do nothing`;
      // A device token of each login, live for the run.
      for (const id of [adm, noArea, mem]) {
        const jti = randomUUID();
        const t = tokens.buildMobileToken(id, jti, 3600, 0);
        await su2`insert into mobile_tokens (id, user_id, label, expires_at)
                  values (${jti}, ${id}, ${tag}, ${t.expiresAt})`;
        bearers.set(id, `Bearer ${t.value}`);
      }
    } finally {
      await su2.end();
    }
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    failArea.mode = 'off';
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  /** A sample of area rows: each area, reads and writes. */
  const SAMPLE: ReadonlyArray<readonly [string, string, unknown?]> = [
    ['GET', '/api/users'],
    ['GET', '/api/team-admin/invites'],
    ['POST', '/api/team-admin/invites', {}],
    ['GET', '/api/ai-workers/config'],
    ['HEAD', '/api/ai-workers/config'],
    ['GET', '/api/keys'],
    ['DELETE', `/api/keys/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`],
    ['GET', '/api/agents'],
    ['PATCH', `/api/agents/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, {}],
    ['GET', '/api/email/accounts'],
    ['GET', '/api/calendar'],
  ];
  const ATTACHMENT = `/api/attachments/${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`;

  it('the sample of area rows: an Admin user with the area, without it, a member, none', async () => {
    const who = { adm, noArea, mem } as const;
    for (const [method, path, body] of SAMPLE) {
      for (const [name, id] of Object.entries(who)) {
        await cell(`${method} ${path} cookie:${name}`, call(method, path, cookieAt(id), body));
      }
      await cell(`${method} ${path} none`, call(method, path, null, body));
    }
    // Member and no-area negative: refused before the handler, never 2xx.
    for (const line of cells) {
      if (/ cookie:(noArea|mem) = /.test(line) || / none = /.test(line)) {
        expect(line, line).toMatch(/ = (401|403) /);
      }
    }
  }, 300_000);

  it('the asset row: the session, an asset token, the render cookie', async () => {
    for (const method of ['GET', 'HEAD']) {
      for (const [name, id] of Object.entries({ adm, noArea, mem })) {
        await cell(`${method} attachment cookie:${name}`, call(method, ATTACHMENT, cookieAt(id)));
        await cell(
          `${method} attachment at:${name}`,
          call(method, `${ATTACHMENT}?at=${atOf(id)}`, null),
        );
        await cell(`${method} attachment render:${name}`, call(method, ATTACHMENT, renderAt(id)));
      }
      await cell(`${method} attachment none`, call(method, ATTACHMENT, null));
    }
    // The asset token of an Admin user without the connectors area is
    // refused, as its session is.
    expect(cells.find((l) => l.startsWith('GET attachment at:noArea = '))).toMatch(/ = 403 /);
  }, 300_000);

  it('a failed area read: every ask, and only the first ask', async () => {
    const rows: ReadonlyArray<readonly [string, string, string | null]> = [
      ['GET', '/api/keys', cookieAt(adm)],
      ['GET', '/api/users', cookieAt(adm)],
      ['GET', ATTACHMENT, cookieAt(adm)],
      ['GET', `${ATTACHMENT}?at=${atOf(adm)}`, null],
      ['GET', '/api/keys', cookieAt(noArea)],
    ];
    for (const fail of ['always', 'once'] as const) {
      for (const [method, path, cookie] of rows) {
        failArea.mode = fail;
        const label = path.startsWith(ATTACHMENT) ? path.replace(ATTACHMENT, 'attachment') : path;
        const name = `${method} ${label.replace(/\?at=.*/, '?at')} fail:${fail} ${cookie ? 'cookie' : 'token'}`;
        await cell(name, call(method, path, cookie));
        failArea.mode = 'off';
      }
    }
    // Never a pass where every ask fails.
    for (const line of cells.filter((l) => l.includes(' fail:always '))) {
      expect(line, line).not.toMatch(/ = 2\d\d /);
    }
  }, 300_000);

  it('a device token on area rows: the Admin user with the area passes (round 2)', async () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/api/users'],
      ['GET', '/api/keys'],
      ['GET', '/api/agents'],
    ];
    for (const [method, path] of rows) {
      for (const [name, id] of Object.entries({ adm, noArea, mem })) {
        await cell(`${method} ${path} bearer:${name}`, call(method, path, bearers.get(id)!));
      }
    }
    // The cell the round 2 inputs name: an Admin user's device token on
    // GET /api/users answers 200; without the area, or a member, refused.
    expect(cells.find((l) => l.startsWith('GET /api/users bearer:adm = '))).toMatch(/ = 200 /);
    for (const line of cells.filter((l) => / bearer:(noArea|mem) = /.test(l))) {
      expect(line, line).toMatch(/ = (401|403) /);
    }
  }, 300_000);

  /**
   * The answers the fold changes (S9 part 2), a class, not these cells
   * alone: on ANY area row (an owner or an asset caller's), an area read
   * that fails once and then answers. Main asked the area again in the
   * guard and could pass; the gate answers the failure, the opaque 500, in
   * the handler's place: stricter, never a pass. These cells are the sample
   * of that class the record holds; every other cell is main's, byte for
   * byte.
   */
  const CHANGED: Readonly<Record<string, string>> = {
    'GET /api/keys fail:once cookie': '500 {"error":"internal error"}',
    'GET /api/users fail:once cookie': '500 {"error":"internal error"}',
    'GET attachment fail:once cookie': '500 {"error":"internal error"}',
  };

  it('the record: written on main (S9_AREA_RECORD=1), compared line for line after', () => {
    const text = `${cells.join('\n')}\n`;
    if (process.env.S9_AREA_RECORD === '1') {
      writeFileSync(RECORDED, text);
      return;
    }
    expect(existsSync(RECORDED), `${RECORDED}: record it on main (S9_AREA_RECORD=1)`).toBe(true);
    const was = readFileSync(RECORDED, 'utf8').split('\n');
    const now = text.split('\n');
    expect(now.length).toBe(was.length);
    const moved: string[] = [];
    for (const [i, line] of now.entries()) {
      if (line === was[i]) continue;
      const name = line.slice(0, line.indexOf(' = '));
      // The cells of one name run in order; a changed one is named above.
      const named = Object.hasOwn(CHANGED, name) && line === `${name} = ${CHANGED[name]}`;
      if (!named) moved.push(`was: ${was[i]}\nnow: ${line}`);
    }
    expect(moved).toEqual([]);
    // And each named change happened (no stale entry).
    for (const [name, answer] of Object.entries(CHANGED)) {
      expect(now, name).toContain(`${name} = ${answer}`);
    }
  });
});
